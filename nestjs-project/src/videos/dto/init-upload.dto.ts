import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class InitUploadDto {
  @ApiProperty({ example: 'clip.mp4', minLength: 1, maxLength: 255 })
  @IsString()
  @Length(1, 255)
  filename: string;

  @ApiProperty({
    example: 'video/mp4',
    description:
      'One of video/mp4, video/webm, video/quicktime, video/x-matroska',
  })
  @IsString()
  @IsNotEmpty()
  content_type: string;

  @ApiProperty({
    example: 11534336,
    minimum: 1,
    maximum: 10737418240,
    description: 'File size in bytes (up to 10GiB)',
  })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: 200,
    description: 'Defaults to the filename without its extension',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;
}
