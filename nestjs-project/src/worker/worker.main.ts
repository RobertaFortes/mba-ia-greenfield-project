import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger('Worker');

  // Not `enableShutdownHooks()`: Nest re-raises the signal after closing, so
  // the process would exit 143 instead of 0. Closing the context lets the
  // BullMQ worker finish the job in flight and release its connections.
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      logger.log(`${signal} received, closing the worker`);
      app
        .close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error(`Shutdown failed: ${String(error)}`);
          process.exit(1);
        });
    });
  }

  logger.log(`Consuming queue "${VIDEO_PROCESSING_QUEUE}" (no HTTP server)`);
}

void bootstrap();
