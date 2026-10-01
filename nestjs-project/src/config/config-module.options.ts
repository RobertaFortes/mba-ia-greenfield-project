import type { ConfigModuleOptions } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import videoConfig from './video.config';

/** Shared by the API and the worker so both validate and load the same env. */
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    queueConfig,
    storageConfig,
    swaggerConfig,
    videoConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};
