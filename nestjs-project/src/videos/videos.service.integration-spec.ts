import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
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
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

describe('VideosService.initUpload (integration)', () => {
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let channelsService: ChannelsService;
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
        StorageModule,
      ],
      providers: [VideosService, ChannelsService],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    channelsService = module.get(ChannelsService);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    await closeModule();
    delete process.env.S3_PUBLIC_ENDPOINT;
    delete process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
