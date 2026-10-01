import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_UPLOAD_PARTS } from '../upload-parts.util';

export class CompletedPartDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_UPLOAD_PARTS })
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_PARTS)
  part_number: number;

  @ApiProperty({ description: 'ETag header returned by storage for the part' })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ type: [CompletedPartDto], maxItems: MAX_UPLOAD_PARTS })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_UPLOAD_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}
