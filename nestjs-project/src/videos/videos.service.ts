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
  VideoUnsupportedContentTypeException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { InitUploadResponseDto } from './dto/init-upload-response.dto';
import type { InitUploadDto } from './dto/init-upload.dto';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { calculatePartPlan } from './upload-parts.util';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_FILE_EXTENSIONS,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

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
    return Promise.all(
      Array.from({ length: totalParts }, async (_, index) => {
        const partNumber = index + 1;
        return {
          part_number: partNumber,
          url: await this.storage.presignUploadPart(
            storageKey,
            uploadId,
            partNumber,
            this.config.uploadUrlExpirationSeconds,
          ),
        };
      }),
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
