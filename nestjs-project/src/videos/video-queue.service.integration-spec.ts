import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import type { VideoProcessingJobData } from './video-processing.types';
import { VideoQueueService } from './video-queue.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

describe('VideoQueueService (integration)', () => {
  let service: VideoQueueService;
  let queue: Queue;
  let closeModule: () => Promise<void>;
  const connection = {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRoot({ connection }),
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
          defaultJobOptions: VIDEO_JOB_OPTIONS,
        }),
      ],
      providers: [VideoQueueService],
    }).compile();
    service = module.get(VideoQueueService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    closeModule = () => module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await closeModule();
  });

  it('should create a process job carrying the video id and storage key', async () => {
    await service.enqueue('video-1', 'videos/video-1/original.mp4');

    const job = await queue.getJob('video-1');
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({
      videoId: 'video-1',
      storageKey: 'videos/video-1/original.mp4',
    });
    expect(job!.id).toBe('video-1');
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    await service.enqueue('video-2', 'videos/video-2/original.mp4');
    await service.enqueue('video-2', 'videos/video-2/original.mp4');

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });

  it('should configure 3 attempts with exponential backoff from 5000 ms', async () => {
    await service.enqueue('video-3', 'videos/video-3/original.mp4');

    const job = await queue.getJob('video-3');
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should keep the job in Redis after the queue is closed and reopened', async () => {
    await service.enqueue('video-4', 'videos/video-4/original.mp4');

    const reopened = new Queue<VideoProcessingJobData>(VIDEO_PROCESSING_QUEUE, {
      connection,
    });
    try {
      const job = await reopened.getJob('video-4');
      expect(job).toBeDefined();
      expect(job!.data.videoId).toBe('video-4');
    } finally {
      await reopened.close();
    }
  });
});
