import { getQueueToken } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { generateTestVideo } from '../test/generate-test-video';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from '../videos/entities/video-status.enum';
import { Video } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let context: INestApplicationContext;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  const keys: string[] = [];

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    dataSource = context.get(DataSource);
    storage = context.get(StorageService, { strict: false });
    queue = context.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
  });

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await context.close();
  });

  it('should boot the application context and process a real job end to end', async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `worker_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'c',
        nickname: `w_${Date.now()}`,
        user_id: user.id,
      }),
    );
    const file = await generateTestVideo({ seconds: 2 });
    const repo = dataSource.getRepository(Video);
    const video = await repo.save(
      repo.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 't',
        status: VideoStatus.PROCESSING,
        original_filename: 'a.mp4',
        content_type: 'video/mp4',
        size_bytes: file.length,
        storage_key: 'pending',
      }),
    );
    video.storage_key = `videos/${video.id}/original.mp4`;
    await repo.save(video);
    await storage.putObject(video.storage_key, file, 'video/mp4');
    keys.push(video.storage_key, `videos/${video.id}/thumbnail.jpg`);

    await queue.add(
      'process',
      { videoId: video.id, storageKey: video.storage_key },
      { jobId: video.id },
    );

    const deadline = Date.now() + 30000;
    let row = await repo.findOneByOrFail({ id: video.id });
    while (row.status !== VideoStatus.READY && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      row = await repo.findOneByOrFail({ id: video.id });
    }
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  }, 60000);
});
