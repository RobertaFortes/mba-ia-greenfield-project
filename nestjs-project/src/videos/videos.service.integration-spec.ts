import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoSizeMismatchException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_JOB_OPTIONS, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

describe('VideosService (integration)', () => {
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let channelsService: ChannelsService;
  let queue: Queue;
  let closeModule: () => Promise<void>;
  let userCounter = 0;

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://storage:9000';
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(5 * MIB);
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        }),
        TypeOrmModule.forFeature([Video, Channel]),
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
        StorageModule,
      ],
      providers: [VideosService, ChannelsService, VideoQueueService],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    channelsService = module.get(ChannelsService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // A worker container may share this Redis: keep the jobs where the test can see them.
    await queue.pause();
    closeModule = () => module.close();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.resume();
    await closeModule();
    delete process.env.S3_PUBLIC_ENDPOINT;
    delete process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await queue.pause();
  });

  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `videos_svc_${++userCounter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { userId: user.id, channelId: channel.id };
  }

  it('should persist the draft, open the multipart and return part URLs that accept bytes', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await service.initUpload(userId, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 11 * MIB,
    });

    expect(result.total_parts).toBe(3);
    expect(result.parts).toHaveLength(3);
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.public_id });
    expect(row).toMatchObject({
      id: result.id,
      status: VideoStatus.DRAFT,
      channel_id: channelId,
      title: 'clip',
      upload_id: result.upload_id,
      part_size_bytes: 5 * MIB,
      total_parts: 3,
      size_bytes: 11 * MIB,
      storage_key: `videos/${result.id}/original.mp4`,
    });

    const put = await fetch(result.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(5 * MIB),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();

    await storage.abortMultipartUpload(row.storage_key, result.upload_id);
  });

  it('should reject a user that has no channel and persist nothing', async () => {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `no_channel_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );

    await expect(
      service.initUpload(user.id, {
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: MIB,
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundException);
    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });

  it('should delete the draft when storage fails after the insert', async () => {
    const { userId } = await createUserWithChannel();
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValueOnce(new Error('storage down'));

    await expect(
      service.initUpload(userId, {
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: MIB,
      }),
    ).rejects.toThrow('storage down');

    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });

  it('should generate a different public id for every upload', async () => {
    const { userId } = await createUserWithChannel();
    const body = {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: MIB,
    };

    const first = await service.initUpload(userId, body);
    const second = await service.initUpload(userId, body);

    expect(first.public_id).not.toBe(second.public_id);
    await storage.abortMultipartUpload(
      `videos/${first.id}/original.mp4`,
      first.upload_id,
    );
    await storage.abortMultipartUpload(
      `videos/${second.id}/original.mp4`,
      second.upload_id,
    );
  });

  const BODY = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 11 * MIB,
  };

  async function putPart(url: string, size: number): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(size),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  }

  const SIZES = [5 * MIB, 5 * MIB, MIB];

  describe('getUploadSession', () => {
    it('should list two uploaded parts and one pending part whose URL accepts the bytes', async () => {
      const { userId } = await createUserWithChannel();
      const init = await service.initUpload(userId, BODY);
      await putPart(init.parts[0].url, SIZES[0]);
      await putPart(init.parts[1].url, SIZES[1]);

      const session = await service.getUploadSession(userId, init.public_id);

      expect(session.uploaded_parts.map((p) => p.part_number)).toEqual([1, 2]);
      expect(session.uploaded_parts[0]).toMatchObject({ size_bytes: 5 * MIB });
      expect(session.uploaded_parts[0].etag).toBeTruthy();
      expect(session.pending_parts).toHaveLength(1);
      expect(session.pending_parts[0].part_number).toBe(3);
      await putPart(session.pending_parts[0].url, SIZES[2]);
      await storage.abortMultipartUpload(
        `videos/${init.id}/original.mp4`,
        init.upload_id,
      );
    });

    it('should hide a video that belongs to another channel', async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const init = await service.initUpload(owner.userId, BODY);

      await expect(
        service.getUploadSession(other.userId, init.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await storage.abortMultipartUpload(
        `videos/${init.id}/original.mp4`,
        init.upload_id,
      );
    });
  });

  describe('completeUpload', () => {
    async function uploadEveryPart(
      userId: string,
      body = BODY,
    ): Promise<{
      init: Awaited<ReturnType<VideosService['initUpload']>>;
      parts: { part_number: number; etag: string }[];
    }> {
      const init = await service.initUpload(userId, body);
      const parts: { part_number: number; etag: string }[] = [];
      for (const part of init.parts) {
        parts.push({
          part_number: part.part_number,
          etag: await putPart(part.url, SIZES[part.part_number - 1]),
        });
      }
      return { init, parts };
    }

    it('should move the video to processing and enqueue the job', async () => {
      const { userId } = await createUserWithChannel();
      const { init, parts } = await uploadEveryPart(userId);

      const result = await service.completeUpload(userId, init.public_id, {
        parts,
      });

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: init.id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      const job = await queue.getJob(init.id);
      expect(job?.data).toEqual({
        videoId: init.id,
        storageKey: `videos/${init.id}/original.mp4`,
      });
      expect((await storage.headObject(row.storage_key)).contentLength).toBe(
        11 * MIB,
      );
      await storage.deleteObject(row.storage_key);
    });

    it('should reject a second completion with VIDEO_INVALID_STATE', async () => {
      const { userId } = await createUserWithChannel();
      const { init, parts } = await uploadEveryPart(userId);
      await service.completeUpload(userId, init.public_id, { parts });

      await expect(
        service.completeUpload(userId, init.public_id, { parts }),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);
      await storage.deleteObject(`videos/${init.id}/original.mp4`);
    });

    it('should map a part with a wrong ETag to a storage rejection that keeps the draft', async () => {
      const { userId } = await createUserWithChannel();
      const { init, parts } = await uploadEveryPart(userId);
      const tampered = parts.map((p) =>
        p.part_number === 2 ? { ...p, etag: '"deadbeef"' } : p,
      );

      await expect(
        service.completeUpload(userId, init.public_id, { parts: tampered }),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_UPLOAD_INCOMPLETE' });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: init.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      await storage.abortMultipartUpload(row.storage_key, init.upload_id);
    });

    it('should fail the video and remove the object when the stored size differs from the declared one', async () => {
      const { userId } = await createUserWithChannel();
      const { init, parts } = await uploadEveryPart(userId, {
        ...BODY,
        size_bytes: 12_000_000,
      });

      await expect(
        service.completeUpload(userId, init.public_id, { parts }),
      ).rejects.toBeInstanceOf(VideoSizeMismatchException);

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: init.id });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.processing_error).toBe('SIZE_MISMATCH');
      await expect(storage.headObject(row.storage_key)).rejects.toThrow();
    });
  });

  describe('abortUpload', () => {
    it('should remove the draft and the multipart upload', async () => {
      const { userId } = await createUserWithChannel();
      const init = await service.initUpload(userId, BODY);
      await putPart(init.parts[0].url, SIZES[0]);

      await service.abortUpload(userId, init.public_id);

      expect(
        await dataSource.getRepository(Video).countBy({ id: init.id }),
      ).toBe(0);
      await expect(
        storage.listParts(`videos/${init.id}/original.mp4`, init.upload_id),
      ).rejects.toThrow();
    });

    it('should answer VIDEO_NOT_FOUND when repeated', async () => {
      const { userId } = await createUserWithChannel();
      const init = await service.initUpload(userId, BODY);
      await service.abortUpload(userId, init.public_id);

      await expect(
        service.abortUpload(userId, init.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
