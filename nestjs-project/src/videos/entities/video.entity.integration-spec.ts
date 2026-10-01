import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { VideoStatus } from './video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `video_entity_${Date.now()}@example.com`,
        password: 'hash',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Channel',
        nickname: `nick_${Date.now()}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  function build(overrides: Partial<Video> = {}): Video {
    return videos.create({
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: 'videos/x/original.mp4',
      ...overrides,
    });
  }

  it('should default the status to draft and nullable columns to null', async () => {
    const saved = await videos.save(build());
    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.thumbnail_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same public_id', async () => {
    const publicId = generatePublicId();
    await videos.save(build({ public_id: publicId }));

    await expect(videos.save(build({ public_id: publicId }))).rejects.toThrow(
      QueryFailedError,
    );
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videos.save(
        build({ channel_id: '00000000-0000-4000-8000-000000000000' }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('should store and read back 10 GiB as a number', async () => {
    const saved = await videos.save(build({ size_bytes: 10737418240 }));
    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should persist jsonb metadata and the processed fields', async () => {
    const saved = await videos.save(
      build({
        status: VideoStatus.READY,
        metadata: { streams: [{ codec_type: 'video' }], tags: { a: 1 } },
        duration_seconds: 12.5,
        width: 1920,
        height: 1080,
        processed_at: new Date(),
      }),
    );
    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual({
      streams: [{ codec_type: 'video' }],
      tags: { a: 1 },
    });
    expect(found.duration_seconds).toBe(12.5);
    expect(found.status).toBe(VideoStatus.READY);
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      videos.save(build({ status: 'archived' as unknown as VideoStatus })),
    ).rejects.toThrow(QueryFailedError);
  });
});
