import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
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

describe('DELETE /videos/:publicId/upload (e2e)', () => {
  let ctx: VideosE2eContext;
  let queue: Queue;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
    queue = ctx.app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
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
    await abortOpenUploads(ctx);
  });

  function abort(publicId: string, token: string | null = owner.accessToken) {
    const req = request(ctx.app.getHttpServer()).delete(
      `/videos/${publicId}/upload`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  it('should remove the draft row and the multipart upload', async () => {
    const upload = await startUpload(ctx, owner);
    const sizes = partSizes(upload, DEFAULT_UPLOAD.size_bytes);
    await putPart(upload.parts[0].url, sizes[0]);

    const res = await abort(upload.public_id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(
      await ctx.dataSource.getRepository(Video).countBy({ id: upload.id }),
    ).toBe(0);
    await expect(
      ctx.storage.listParts(
        `videos/${upload.id}/original.mp4`,
        upload.upload_id,
      ),
    ).rejects.toThrow();
  });

  it('should answer 404 when the abort is repeated', async () => {
    const upload = await startUpload(ctx, owner);
    await abort(upload.public_id).expect(204);

    const res = await abort(upload.public_id);

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  it('should answer 409 for a video that is no longer a draft and leave it untouched', async () => {
    const upload = await startUpload(ctx, owner);
    const parts = await uploadAllParts(upload);
    await request(ctx.app.getHttpServer())
      .post(`/videos/${upload.public_id}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ parts })
      .expect(202);

    const res = await abort(upload.public_id);

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('VIDEO_INVALID_STATE');
    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: upload.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });

  it("should answer 404 when aborting another channel's draft", async () => {
    const upload = await startUpload(ctx, owner);
    const intruder = await registerConfirmAndLogin(ctx, 'intruder@example.com');

    const res = await abort(upload.public_id, intruder.accessToken);

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    expect(
      await ctx.dataSource.getRepository(Video).countBy({ id: upload.id }),
    ).toBe(1);
  });

  it('should reject a request without a bearer token', async () => {
    const upload = await startUpload(ctx, owner);

    const res = await abort(upload.public_id, null);

    expect(res.status).toBe(401);
  });
});
