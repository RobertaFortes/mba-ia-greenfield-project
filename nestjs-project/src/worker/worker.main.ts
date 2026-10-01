import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log(
    `Consuming queue "${VIDEO_PROCESSING_QUEUE}" (no HTTP server)`,
  );
}

void bootstrap();
