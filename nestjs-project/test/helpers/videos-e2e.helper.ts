import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { VideoProcessingModule } from '../../src/videos/processing/video-processing.module';
import { generateTestVideo } from '../../src/test/generate-test-video';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import storageConfig from '../../src/config/storage.config';
import videoConfig from '../../src/config/video.config';
import { MailService } from '../../src/mail/mail.service';
import { StorageService } from '../../src/storage/storage.service';
import { Video } from '../../src/videos/entities/video.entity';

export interface VideosE2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
  storage: StorageService;
  close: () => Promise<void>;
}

export interface AuthenticatedUser {
  email: string;
  accessToken: string;
  channelId: string;
}

export interface E2eConfigOverrides {
  /** Runs the queue consumer inside the test process, next to the API. */
  withProcessing?: boolean;
  video?: Partial<ReturnType<typeof videoConfig>>;
  storage?: Partial<ReturnType<typeof storageConfig>>;
}

/**
 * Boots the real AppModule (real Postgres, Redis and storage). The config
 * namespaces are overridden at the provider level: ~11 MiB must use three
 * parts, and presigned URLs must be reachable from inside the container,
 * where the client-facing host is the storage service.
 */
export async function bootstrapVideosApp(
  overrides: E2eConfigOverrides = {},
): Promise<VideosE2eContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: overrides.withProcessing
      ? [AppModule, VideoProcessingModule]
      : [AppModule],
  })
    .overrideProvider(videoConfig.KEY)
    .useValue({
      ...videoConfig(),
      uploadPartSizeBytes: 5 * 1024 * 1024,
      ...overrides.video,
    })
    .overrideProvider(storageConfig.KEY)
    .useValue({
      ...storageConfig(),
      publicEndpoint: 'http://storage:9000',
      ...overrides.storage,
    })
    .compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
    storage: moduleFixture.get(StorageService),
    close: async () => {
      await app.close();
    },
  };
}

/** Registers, confirms and logs in through the real auth endpoints. */
export async function registerConfirmAndLogin(
  ctx: VideosE2eContext,
  email: string,
  password = 'password123',
): Promise<AuthenticatedUser> {
  const server = ctx.app.getHttpServer();
  let confirmationToken = '';
  const spy = jest
    .spyOn(ctx.app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });
  await request(server).post('/auth/register').send({ email, password });
  spy.mockRestore();
  await request(server)
    .get('/auth/confirm-email')
    .query({ token: confirmationToken });
  const login = await request(server)
    .post('/auth/login')
    .send({ email, password });
  const accessToken = (login.body as { access_token: string }).access_token;

  const row = await ctx.dataSource.query<{ id: string }[]>(
    `SELECT c.id FROM channels c JOIN users u ON u.id = c.user_id WHERE u.email = $1`,
    [email],
  );
  return { email, accessToken, channelId: row[0].id };
}

/** Throttler counters are per IP and shared by the whole suite. */
export function resetThrottler(ctx: VideosE2eContext): void {
  ctx.throttlerStorage.storage.clear();
}

/** Aborts multipart uploads left open by a test so storage stays clean. */
export async function abortOpenUploads(ctx: VideosE2eContext): Promise<void> {
  const open = await ctx.dataSource
    .getRepository(Video)
    .createQueryBuilder('video')
    .where('video.upload_id IS NOT NULL')
    .getMany();
  for (const video of open) {
    await ctx.storage
      .abortMultipartUpload(video.storage_key, video.upload_id as string)
      .catch(() => undefined);
  }
}

export const MIB = 1024 * 1024;

export interface StartedUpload {
  id: string;
  public_id: string;
  status: string;
  upload_id: string;
  part_size_bytes: number;
  total_parts: number;
  parts: { part_number: number; url: string }[];
}

export interface UploadedPartRef {
  part_number: number;
  etag: string;
}

export const DEFAULT_UPLOAD = {
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: 11 * MIB,
};

/** POST /videos through the real endpoint. */
export async function startUpload(
  ctx: VideosE2eContext,
  user: AuthenticatedUser,
  body: Record<string, unknown> = DEFAULT_UPLOAD,
): Promise<StartedUpload> {
  const res = await request(ctx.app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send(body);
  if (res.status !== 201) {
    throw new Error(`POST /videos answered ${res.status}: ${res.text}`);
  }
  return res.body as StartedUpload;
}

/** PUTs bytes to a presigned part URL and returns the part ETag. */
export async function putPart(url: string, size: number): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(size),
  });
  if (response.status !== 200) {
    throw new Error(`Part upload answered ${response.status}`);
  }
  return response.headers.get('etag') as string;
}

/** Sizes of each part for a file of `totalBytes` (last part is the remainder). */
export function partSizes(upload: StartedUpload, totalBytes: number): number[] {
  return Array.from({ length: upload.total_parts }, (_, index) =>
    index < upload.total_parts - 1
      ? upload.part_size_bytes
      : totalBytes - index * upload.part_size_bytes,
  );
}

export async function uploadAllParts(
  upload: StartedUpload,
  totalBytes = DEFAULT_UPLOAD.size_bytes,
): Promise<UploadedPartRef[]> {
  const sizes = partSizes(upload, totalBytes);
  const refs: UploadedPartRef[] = [];
  for (const part of upload.parts) {
    refs.push({
      part_number: part.part_number,
      etag: await putPart(part.url, sizes[part.part_number - 1]),
    });
  }
  return refs;
}

let cachedLargeVideo: Buffer | undefined;

/** A real ~11 MiB H.264/AAC MP4 (three 5 MiB-part uploads), generated once per process. */
export async function largeTestVideo(): Promise<Buffer> {
  cachedLargeVideo ??= await generateTestVideo({
    seconds: 10,
    width: 640,
    height: 360,
    constantBitrate: '9M',
  });
  return cachedLargeVideo;
}

/** Sends `file` to the presigned part URLs, slicing it exactly as the plan dictates. */
export async function uploadFile(
  upload: StartedUpload,
  file: Buffer,
): Promise<UploadedPartRef[]> {
  const refs: UploadedPartRef[] = [];
  for (const part of upload.parts) {
    const start = (part.part_number - 1) * upload.part_size_bytes;
    const slice = file.subarray(start, start + upload.part_size_bytes);
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(slice),
    });
    if (response.status !== 200) {
      throw new Error(`Part ${part.part_number} answered ${response.status}`);
    }
    refs.push({
      part_number: part.part_number,
      etag: response.headers.get('etag') as string,
    });
  }
  return refs;
}

export async function waitForStatus(
  ctx: VideosE2eContext,
  user: AuthenticatedUser,
  publicId: string,
  wanted: string,
  timeoutMs = 60000,
): Promise<{ status: string; processing_error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    const body = res.body as {
      status: string;
      processing_error: string | null;
    };
    if (body.status === wanted) return body;
    if (Date.now() > deadline) {
      throw new Error(`Video stayed ${body.status}, expected ${wanted}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Produces a `ready` video through the real pipeline: init, parts, complete, processing. */
export async function createReadyVideo(
  ctx: VideosE2eContext,
  user: AuthenticatedUser,
  filename = 'clip.mp4',
): Promise<StartedUpload> {
  const file = await largeTestVideo();
  const upload = await startUpload(ctx, user, {
    filename,
    content_type: 'video/mp4',
    size_bytes: file.length,
  });
  const parts = await uploadFile(upload, file);
  const res = await request(ctx.app.getHttpServer())
    .post(`/videos/${upload.public_id}/upload/complete`)
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({ parts });
  if (res.status !== 202) {
    throw new Error(`complete answered ${res.status}: ${res.text}`);
  }
  await waitForStatus(ctx, user, upload.public_id, 'ready');
  return upload;
}
