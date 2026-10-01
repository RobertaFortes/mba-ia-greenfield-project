import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmAsyncOptions } from '../database/typeorm.options';
import { bullAsyncOptions } from '../queue/bull.options';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingModule } from '../videos/processing/video-processing.module';

/** The video-processing consumer, run as its own process (no HTTP server). */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    // Video -> Channel -> User relations need all three registered in the metadata.
    TypeOrmModule.forFeature([User, Channel, Video]),
    BullModule.forRootAsync(bullAsyncOptions),
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
