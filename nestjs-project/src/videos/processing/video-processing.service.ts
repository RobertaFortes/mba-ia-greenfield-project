import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { NoVideoStreamError } from './probe-parser.util';
import { PermanentProcessingError } from './video-processing.errors';
import { calculateThumbnailTime } from './thumbnail-time.util';

export const PROCESSING_ERROR_MAX_LENGTH = 500;
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /** Idempotent: a video that is already `ready` is left untouched. */
  async process(videoId: string): Promise<void> {
    const video = await this.videos.findOneBy({ id: videoId });
    if (!video) {
      throw new PermanentProcessingError(`Video ${videoId} does not exist`);
    }
    if (video.status === VideoStatus.READY) return;
    if (video.status !== VideoStatus.PROCESSING) {
      throw new PermanentProcessingError(
        `Video ${videoId} is ${video.status}, expected processing`,
      );
    }

    const url = await this.storage.presignInternalGet(
      video.storage_key,
      this.config.processingTimeoutSeconds * 2,
    );
    let probe;
    try {
      probe = await this.ffmpeg.probe(url);
    } catch (error) {
      if (error instanceof NoVideoStreamError) {
        throw new PermanentProcessingError(error.message);
      }
      throw error;
    }
    const thumbnail = await this.ffmpeg.extractThumbnail(
      url,
      calculateThumbnailTime(probe.durationSeconds),
    );
    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await this.storage.putObject(
      thumbnailKey,
      thumbnail,
      THUMBNAIL_CONTENT_TYPE,
    );

    Object.assign(video, {
      status: VideoStatus.READY,
      duration_seconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      video_codec: probe.videoCodec,
      audio_codec: probe.audioCodec,
      bitrate: probe.bitrate,
      format_name: probe.formatName,
      fps: probe.fps,
      metadata: probe.raw as unknown as Record<string, unknown>,
      thumbnail_key: thumbnailKey,
      processing_error: null,
      processed_at: new Date(),
    });
    await this.videos.save(video);
  }

  /** Only a video still in `processing` can fail; a `ready` one is never downgraded. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        processing_error: reason.slice(0, PROCESSING_ERROR_MAX_LENGTH),
      },
    );
  }
}
