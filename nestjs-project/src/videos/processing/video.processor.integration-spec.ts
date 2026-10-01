import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { generateTestVideo } from '../../test/generate-test-video';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { generatePublicId } from '../public-id.util';
import { VideoQueueService } from '../video-queue.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingModule } from './video-processing.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Needs the only consumer of the `video-processing` queue to be this test:
 * stop the `video-worker` container while running it.
 */
describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let storage: StorageService;
  let ffmpeg: FfmpegService;
  let queue: Queue;
  let queueService: VideoQueueService;
  let closeModule: () => Promise<void>;
  let channelId: string;
  const keys: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        }),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
          defaultJobOptions: VIDEO_JOB_OPTIONS,
        }),
        VideoProcessingModule,
      ],
      providers: [VideoQueueService],
    }).compile();
    await module.init();
    dataSource = module.get(DataSource);
    storage = module.get(StorageService, { strict: false });
    ffmpeg = module.get(FfmpegService, { strict: false });
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    queueService = module.get(VideoQueueService);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await queue.obliterate({ force: true });
    await closeModule();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `processor_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'c',
        nickname: `p_${Date.now()}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  async function processingVideo(file: Buffer): Promise<Video> {
    const repo = dataSource.getRepository(Video);
    const draft = await repo.save(
      repo.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        title: 't',
        status: VideoStatus.PROCESSING,
        original_filename: 'a.mp4',
        content_type: 'video/mp4',
        size_bytes: file.length,
        storage_key: 'pending',
      }),
    );
    draft.storage_key = `videos/${draft.id}/original.mp4`;
    await repo.save(draft);
    await storage.putObject(draft.storage_key, file, 'video/mp4');
    keys.push(draft.storage_key, `videos/${draft.id}/thumbnail.jpg`);
    return draft;
  }

  async function waitForStatus(
    id: string,
    wanted: VideoStatus,
    timeoutMs = 30000,
  ): Promise<Video> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await dataSource.getRepository(Video).findOneByOrFail({ id });
      if (row.status === wanted) return row;
      if (Date.now() > deadline) {
        throw new Error(`Video stayed ${row.status}, expected ${wanted}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it('should take an enqueued valid video to ready', async () => {
    const video = await processingVideo(await generateTestVideo());

    await queueService.enqueue(video.id, video.storage_key);

    const row = await waitForStatus(video.id, VideoStatus.READY);
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(row.duration_seconds).toBeGreaterThan(0);
  });

  it('should fail a file without a video stream at once, without retrying', async () => {
    const probe = jest.spyOn(ffmpeg, 'probe');
    const video = await processingVideo(
      await generateTestVideo({ audioOnly: true }),
    );

    await queueService.enqueue(video.id, video.storage_key);

    const row = await waitForStatus(video.id, VideoStatus.FAILED);
    expect(row.processing_error).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('should retry a transient failure and fail only after the last attempt', async () => {
    const probe = jest
      .spyOn(ffmpeg, 'probe')
      .mockRejectedValue(new Error('transient storage error'));
    const video = await processingVideo(await generateTestVideo());

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id, storageKey: video.storage_key },
      {
        jobId: video.id,
        attempts: 3,
        backoff: { type: 'fixed', delay: 300 },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    const early = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(early.status).toBe(VideoStatus.PROCESSING);

    const row = await waitForStatus(video.id, VideoStatus.FAILED);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(row.processing_error).toContain('transient storage error');
  });
});
