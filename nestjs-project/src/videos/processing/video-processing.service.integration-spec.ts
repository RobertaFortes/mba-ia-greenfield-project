import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { StorageModule } from '../../storage/storage.module';
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
import { FfmpegService } from './ffmpeg.service';
import { PermanentProcessingError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let closeModule: () => Promise<void>;
  let channelId: string;
  const keys: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingService],
    }).compile();
    await module.init();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await closeModule();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `processing_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'c',
        nickname: `c_${Date.now()}`,
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

  it('should turn a valid video into ready with metadata and a stored JPEG thumbnail', async () => {
    const video = await processingVideo(
      await generateTestVideo({ seconds: 3, width: 320, height: 240, fps: 25 }),
    );

    await service.process(video.id);

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeCloseTo(3, 0);
    expect(row).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      fps: 25,
      thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
    });
    expect(row.metadata).toBeTruthy();
    expect(row.processed_at).toBeInstanceOf(Date);
    const head = await storage.headObject(row.thumbnail_key as string);
    expect(head.contentLength).toBeGreaterThan(0);
  });

  it('should change nothing when the video is already ready', async () => {
    const video = await processingVideo(await generateTestVideo());
    await service.process(video.id);
    const before = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });

    await service.process(video.id);

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.processed_at).toEqual(before.processed_at);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it('should reject a file without a video stream as a permanent error', async () => {
    const video = await processingVideo(
      await generateTestVideo({ audioOnly: true }),
    );

    await expect(service.process(video.id)).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it('should mark a processing video failed with a bounded error', async () => {
    const video = await processingVideo(Buffer.from('not media'));

    await service.markFailed(video.id, 'e'.repeat(900));

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.processing_error).toHaveLength(500);
  });
});
