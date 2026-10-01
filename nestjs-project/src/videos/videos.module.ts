import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_JOB_OPTIONS, VIDEO_PROCESSING_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_JOB_OPTIONS,
    }),
    ChannelsModule,
  ],
  providers: [VideoQueueService],
  exports: [TypeOrmModule, VideoQueueService],
})
export class VideosModule {}
