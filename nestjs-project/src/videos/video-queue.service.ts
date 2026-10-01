import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import type { VideoProcessingJobData } from './video-processing.types';

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJobData>,
  ) {}

  /** `jobId = videoId` keeps the enqueue idempotent (at-least-once safe). */
  async enqueue(videoId: string, storageKey: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId, storageKey },
      { jobId: videoId },
    );
  }
}
