import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  VideoFileTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoQueueUnavailableException,
  VideoSizeMismatchException,
  VideoUnsupportedContentTypeException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type {
  CompleteUploadDto,
  CompleteUploadResponseDto,
} from './dto/complete-upload.dto';
import type { InitUploadResponseDto } from './dto/init-upload-response.dto';
import type { InitUploadDto } from './dto/init-upload.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import type { UploadSessionResponse } from './dto/upload-session.response';
import { generatePublicId } from './public-id.util';
import { VideoQueueService } from './video-queue.service';
import { calculatePartPlan } from './upload-parts.util';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_FILE_EXTENSIONS,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

const FAILURE_REASONS = {
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  ENQUEUE_FAILED: 'ENQUEUE_FAILED',
} as const;

const PART_REJECTION_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

function errorName(error: unknown): string | undefined {
  return (error as { name?: string } | null)?.name;
}

function isStorageRejectionOfParts(error: unknown): boolean {
  return PART_REJECTION_ERRORS.has(errorName(error) ?? '');
}

function isNoSuchUpload(error: unknown): boolean {
  return errorName(error) === 'NoSuchUpload';
}

type AllowedContentType = (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];

function isAllowedContentType(value: string): value is AllowedContentType {
  return (ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(value);
}

function defaultTitle(filename: string): string {
  const name = parse(filename).name || filename;
  return name.slice(0, VIDEO_TITLE_MAX_LENGTH);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly channels: ChannelsService,
    private readonly storage: StorageService,
    private readonly queue: VideoQueueService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<InitUploadResponseDto> {
    const channel = await this.channels.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();
    if (dto.size_bytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoFileTooLargeException();
    }
    if (!isAllowedContentType(dto.content_type)) {
      throw new VideoUnsupportedContentTypeException();
    }

    const plan = calculatePartPlan(
      dto.size_bytes,
      this.config.uploadPartSizeBytes,
    );
    const id = randomUUID();
    const storageKey = `videos/${id}/original.${VIDEO_FILE_EXTENSIONS[dto.content_type]}`;
    const draft = await this.insertDraft({
      id,
      channel_id: channel.id,
      title: dto.title ?? defaultTitle(dto.filename),
      original_filename: dto.filename,
      content_type: dto.content_type,
      size_bytes: dto.size_bytes,
      storage_key: storageKey,
    });

    let uploadId: string | undefined;
    try {
      uploadId = await this.storage.createMultipartUpload(
        storageKey,
        dto.content_type,
      );
      await this.videos.update(draft.id, {
        upload_id: uploadId,
        part_size_bytes: plan.partSizeBytes,
        total_parts: plan.totalParts,
      });
      const parts = await this.presignParts(
        storageKey,
        uploadId,
        plan.totalParts,
      );
      return {
        id: draft.id,
        public_id: draft.public_id,
        status: VideoStatus.DRAFT,
        title: draft.title,
        upload_id: uploadId,
        part_size_bytes: plan.partSizeBytes,
        total_parts: plan.totalParts,
        url_expires_in_seconds: this.config.uploadUrlExpirationSeconds,
        parts,
      };
    } catch (error) {
      await this.discardDraft(draft.id, storageKey, uploadId);
      throw error;
    }
  }

  async getUploadSession(
    userId: string,
    publicId: string,
  ): Promise<UploadSessionResponse> {
    const video = await this.findOwnedVideo(userId, publicId);
    const base = {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      title: video.title,
      processing_error: video.processing_error,
    };
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      return {
        ...base,
        upload_id: null,
        part_size_bytes: null,
        total_parts: null,
        url_expires_in_seconds: null,
        uploaded_parts: [],
        pending_parts: [],
      };
    }

    const stored = await this.storage.listParts(
      video.storage_key,
      video.upload_id,
    );
    const storedNumbers = new Set(stored.map((part) => part.partNumber));
    const totalParts = video.total_parts as number;
    const missing = Array.from({ length: totalParts }, (_, i) => i + 1).filter(
      (partNumber) => !storedNumbers.has(partNumber),
    );
    return {
      ...base,
      upload_id: video.upload_id,
      part_size_bytes: video.part_size_bytes,
      total_parts: totalParts,
      url_expires_in_seconds: this.config.uploadUrlExpirationSeconds,
      uploaded_parts: stored.map((part) => ({
        part_number: part.partNumber,
        size_bytes: part.size,
        etag: part.etag,
      })),
      pending_parts: await this.presignPartNumbers(
        video.storage_key,
        video.upload_id,
        missing,
      ),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStateException();
    }
    if (!this.coversEveryPart(dto, video.total_parts as number)) {
      throw new VideoUploadIncompleteException();
    }

    try {
      await this.storage.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (isStorageRejectionOfParts(error)) {
        throw new VideoUploadIncompleteException();
      }
      throw error;
    }

    const stored = await this.storage.headObject(video.storage_key);
    if (stored.contentLength !== video.size_bytes) {
      await this.storage.deleteObject(video.storage_key);
      await this.markFailed(video.id, FAILURE_REASONS.SIZE_MISMATCH);
      throw new VideoSizeMismatchException();
    }

    await this.videos.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });
    try {
      await this.queue.enqueue(video.id, video.storage_key);
    } catch {
      await this.markFailed(video.id, FAILURE_REASONS.ENQUEUE_FAILED);
      throw new VideoQueueUnavailableException();
    }
    return {
      id: video.id,
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException();
    }
    if (video.upload_id) {
      await this.storage
        .abortMultipartUpload(video.storage_key, video.upload_id)
        .catch((error: unknown) => {
          if (!isNoSuchUpload(error)) throw error;
        });
    }
    await this.videos.delete(video.id);
  }

  /** Owner-only lookup: another channel's video is indistinguishable from a missing one. */
  private async findOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const channel = await this.channels.findByUserId(userId);
    if (!channel) throw new VideoNotFoundException();
    const video = await this.videos.findOneBy({
      public_id: publicId,
      channel_id: channel.id,
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private coversEveryPart(dto: CompleteUploadDto, totalParts: number): boolean {
    const submitted = new Set(dto.parts.map((part) => part.part_number));
    if (submitted.size !== dto.parts.length) return false;
    if (submitted.size !== totalParts) return false;
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      if (!submitted.has(partNumber)) return false;
    }
    return true;
  }

  private async markFailed(id: string, reason: string): Promise<void> {
    await this.videos.update(id, {
      status: VideoStatus.FAILED,
      upload_id: null,
      processing_error: reason,
    });
  }

  private async insertDraft(
    fields: Pick<
      Video,
      | 'id'
      | 'channel_id'
      | 'title'
      | 'original_filename'
      | 'content_type'
      | 'size_bytes'
      | 'storage_key'
    >,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({
            ...fields,
            public_id: generatePublicId(),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (error) {
        const collision = isPgUniqueViolationOnColumn(error, 'public_id');
        if (!collision || attempt >= PUBLIC_ID_MAX_ATTEMPTS) throw error;
      }
    }
  }

  private async presignParts(
    storageKey: string,
    uploadId: string,
    totalParts: number,
  ): Promise<{ part_number: number; url: string }[]> {
    return this.presignPartNumbers(
      storageKey,
      uploadId,
      Array.from({ length: totalParts }, (_, index) => index + 1),
    );
  }

  private async presignPartNumbers(
    storageKey: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ part_number: number; url: string }[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
          this.config.uploadUrlExpirationSeconds,
        ),
      })),
    );
  }

  /** Compensation: leaves neither a draft row nor an orphan multipart upload. */
  private async discardDraft(
    id: string,
    storageKey: string,
    uploadId: string | undefined,
  ): Promise<void> {
    if (uploadId) {
      await this.storage
        .abortMultipartUpload(storageKey, uploadId)
        .catch(() => {
          // best effort: the original error is what the caller needs to see
        });
    }
    await this.videos.delete(id);
  }
}
