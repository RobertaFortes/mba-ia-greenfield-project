import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import type { VideoProcessingJobData } from '../video-processing.types';
import { PermanentProcessingError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    try {
      await this.processing.process(job.data.videoId);
    } catch (error) {
      if (error instanceof PermanentProcessingError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /** Fires on every failed attempt; only the last one (or an unrecoverable error) is final. */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted && !(error instanceof UnrecoverableError)) return;
    this.logger.error(`Video ${job.data.videoId} failed: ${error.message}`);
    await this.processing.markFailed(job.data.videoId, error.message);
  }
}
