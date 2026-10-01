import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  CompleteUploadDto,
  CompleteUploadResponseDto,
} from './dto/complete-upload.dto';
import { InitUploadResponseDto } from './dto/init-upload-response.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadSessionResponse } from './dto/upload-session.response';
import { ParseVideoPublicIdPipe } from './parse-video-public-id.pipe';
import { VideosService } from './videos.service';

const UPLOAD_MANAGEMENT_THROTTLE = { default: { limit: 60, ttl: 60000 } };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @Throttle(UPLOAD_MANAGEMENT_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel, opens an S3 multipart upload and returns one presigned PUT URL per part. The client sends the bytes straight to storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created; upload parts can be sent to the URLs',
    type: InitUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, file above 10GiB (VIDEO_FILE_TOO_LARGE) or unsupported content type (VIDEO_UNSUPPORTED_CONTENT_TYPE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel (CHANNEL_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ): Promise<InitUploadResponseDto> {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Get(':publicId/upload')
  @Throttle(UPLOAD_MANAGEMENT_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the upload session',
    description:
      'Lets the owner resume an interrupted upload: lists the parts already stored and returns fresh presigned URLs for the missing ones. For videos that are no longer drafts it reports the status with empty arrays.',
  })
  @ApiResponse({ status: 200, type: UploadSessionResponse })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown or malformed publicId, or the video belongs to another channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadSession(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', ParseVideoPublicIdPipe) publicId: string,
  ): Promise<UploadSessionResponse> {
    return this.videosService.getUploadSession(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(UPLOAD_MANAGEMENT_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Finishes the multipart upload, verifies the stored size, moves the video to processing and publishes the processing job.',
  })
  @ApiResponse({ status: 202, type: CompleteUploadResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, parts do not cover the upload (VIDEO_UPLOAD_INCOMPLETE) or the stored size differs from the declared one (VIDEO_SIZE_MISMATCH)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown or foreign video (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not a draft (VIDEO_INVALID_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'The processing job could not be enqueued (VIDEO_QUEUE_UNAVAILABLE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', ParseVideoPublicIdPipe) publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(UPLOAD_MANAGEMENT_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort the upload',
    description:
      'Cancels an in-progress upload: aborts the multipart upload in storage and removes the draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown or foreign video (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not a draft (VIDEO_INVALID_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', ParseVideoPublicIdPipe) publicId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, publicId);
  }
}
