import { ApiProperty } from '@nestjs/swagger';

export class PublicVideoResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ example: 'ready' })
  status: string;

  @ApiProperty({ example: 12.5 })
  duration_seconds: number;

  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ nullable: true, type: String, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ description: 'Bits per second', example: 2500000 })
  bitrate: number;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string;

  @ApiProperty({ example: 29.97 })
  fps: number;

  @ApiProperty({
    description:
      'Presigned GET URL of the thumbnail, valid for VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS',
  })
  thumbnail_url: string;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  processed_at: string;
}
