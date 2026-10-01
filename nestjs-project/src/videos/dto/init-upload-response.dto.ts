import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: 10000 })
  part_number: number;

  @ApiProperty({ description: 'Presigned PUT URL for this part' })
  url: string;
}

export class InitUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: '11-character public id',
  })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty()
  title: string;

  @ApiProperty({ description: 'S3 multipart UploadId' })
  upload_id: string;

  @ApiProperty({ example: 134217728 })
  part_size_bytes: number;

  @ApiProperty({ example: 80 })
  total_parts: number;

  @ApiProperty({ example: 3600 })
  url_expires_in_seconds: number;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];
}
