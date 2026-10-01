import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VIDEO_JOB_OPTIONS, VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    StorageModule,
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_JOB_OPTIONS,
    }),
  ],
  providers: [FfmpegService, VideoProcessingService, VideoProcessor],
})
export class VideoProcessingModule {}
