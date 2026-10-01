import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video-status.enum';
import { UploadPartUrlDto } from './init-upload-response.dto';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 5242880 })
  size_bytes: number;

  @ApiProperty({ description: 'ETag storage returned for this part' })
  etag: string;
}

export class UploadSessionResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true, type: String })
  processing_error: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Only while draft',
  })
  upload_id: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Only while draft',
  })
  part_size_bytes: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Only while draft',
  })
  total_parts: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Only while draft',
  })
  url_expires_in_seconds: number | null;

  @ApiProperty({ type: [UploadedPartDto], description: 'Empty unless draft' })
  uploaded_parts: UploadedPartDto[];

  @ApiProperty({
    type: [UploadPartUrlDto],
    description:
      'Presigned URLs of the parts not stored yet; empty unless draft',
  })
  pending_parts: UploadPartUrlDto[];
}
