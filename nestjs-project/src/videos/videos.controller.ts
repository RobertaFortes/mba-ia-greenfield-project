import { Body, Controller, Post } from '@nestjs/common';
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
import { InitUploadResponseDto } from './dto/init-upload-response.dto';
import { InitUploadDto } from './dto/init-upload.dto';
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
}
