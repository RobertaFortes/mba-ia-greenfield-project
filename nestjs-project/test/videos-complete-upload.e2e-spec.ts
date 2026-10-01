import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { VideoQueueService } from '../src/videos/video-queue.service';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import {
  abortOpenUploads,
  bootstrapVideosApp,
  DEFAULT_UPLOAD,
  partSizes,
  putPart,
  registerConfirmAndLogin,
  resetThrottler,
  startUpload,
  uploadAllParts,
  type AuthenticatedUser,
  type VideosE2eContext,
} from './helpers/videos-e2e.helper';

interface ErrorBody {
  error?: string;
  status?: string;
  id?: string;
  public_id?: string;
}

describe('POST /videos/:publicId/upload/complete (e2e)', () => {
  let ctx: VideosE2eContext;
  let queue: Queue;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
    queue = ctx.app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // A worker container may share this Redis: keep the jobs where the test can read them.
    await queue.pause();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.resume();
    await ctx.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    await queue.obliterate({ force: true });
    await queue.pause();
    resetThrottler(ctx);
    owner = await registerConfirmAndLogin(ctx, 'owner@example.com');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await abortOpenUploads(ctx);
  });

  function complete(
    publicId: string,
    body: unknown,
    token: string | null = owner.accessToken,
  ) {
    const req = request(ctx.app.getHttpServer()).post(
      `/videos/${publicId}/upload/complete`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body as object);
  }

  describe('success', () => {
    it('should move the video to processing and enqueue the job', async () => {
      const upload = await startUpload(ctx, owner);
      const parts = await uploadAllParts(upload);

      const res = await complete(upload.public_id, { parts });
      const body = res.body as ErrorBody;

      expect(res.status).toBe(202);
      expect(body).toEqual({
        id: upload.id,
        public_id: upload.public_id,
        status: 'processing',
      });
      const job = await queue.getJob(upload.id);
      expect(job).toBeDefined();
      expect(job?.id).toBe(upload.id);
      expect(job?.data).toEqual({
        videoId: upload.id,
        storageKey: `videos/${upload.id}/original.mp4`,
      });
    });

    it('should reject a second completion with a conflict', async () => {
      const upload = await startUpload(ctx, owner);
      const parts = await uploadAllParts(upload);
      await complete(upload.public_id, { parts }).expect(202);

      const res = await complete(upload.public_id, { parts });

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('VIDEO_INVALID_STATE');
    });
  });

  describe('incomplete or inconsistent uploads', () => {
    it('should reject missing parts and keep the video as a draft', async () => {
      const upload = await startUpload(ctx, owner);
      const sizes = partSizes(upload, DEFAULT_UPLOAD.size_bytes);
      const parts = [
        { part_number: 1, etag: await putPart(upload.parts[0].url, sizes[0]) },
        { part_number: 2, etag: await putPart(upload.parts[1].url, sizes[1]) },
      ];

      const res = await complete(upload.public_id, { parts });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VIDEO_UPLOAD_INCOMPLETE');
      const row = await ctx.dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: upload.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
    });

    it('should fail the video and remove the object when the size does not match', async () => {
      const upload = await startUpload(ctx, owner, {
        ...DEFAULT_UPLOAD,
        size_bytes: 12_000_000,
      });
      expect(upload.total_parts).toBe(3);
      const parts = await uploadAllParts(upload, DEFAULT_UPLOAD.size_bytes);

      const res = await complete(upload.public_id, { parts });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VIDEO_SIZE_MISMATCH');
      const row = await ctx.dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: upload.id });
      expect(row.status).toBe(VideoStatus.FAILED);
      await expect(ctx.storage.headObject(row.storage_key)).rejects.toThrow();
    });

    it('should answer 503 and fail the video when the queue is unavailable', async () => {
      jest
        .spyOn(ctx.app.get(VideoQueueService), 'enqueue')
        .mockRejectedValue(new Error('redis down'));
      const upload = await startUpload(ctx, owner);
      const parts = await uploadAllParts(upload);

      const res = await complete(upload.public_id, { parts });

      expect(res.status).toBe(503);
      expect((res.body as ErrorBody).error).toBe('VIDEO_QUEUE_UNAVAILABLE');
      const row = await ctx.dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: upload.id });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.processing_error).toBe('ENQUEUE_FAILED');
    });
  });

  describe('access control and validation', () => {
    it("should answer 404 when completing another channel's draft", async () => {
      const upload = await startUpload(ctx, owner);
      const parts = await uploadAllParts(upload);
      const intruder = await registerConfirmAndLogin(
        ctx,
        'intruder@example.com',
      );

      const res = await complete(
        upload.public_id,
        { parts },
        intruder.accessToken,
      );

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('should reject an empty parts array', async () => {
      const upload = await startUpload(ctx, owner);

      const res = await complete(upload.public_id, { parts: [] });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('should reject a request without a bearer token', async () => {
      const upload = await startUpload(ctx, owner);

      const res = await complete(upload.public_id, { parts: [] }, null);

      expect(res.status).toBe(401);
    });
  });
});
