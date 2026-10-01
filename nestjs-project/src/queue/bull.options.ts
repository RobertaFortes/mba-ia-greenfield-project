import type { SharedBullAsyncConfiguration } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

export const bullAsyncOptions: SharedBullAsyncConfiguration = {
  inject: [queueConfig.KEY],
  useFactory: (queue: ConfigType<typeof queueConfig>) => ({
    connection: { host: queue.host, port: queue.port },
  }),
};
