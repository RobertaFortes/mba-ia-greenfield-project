import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { generatePublicId } from '../src/videos/public-id.util';
import {
  abortOpenUploads,
  bootstrapVideosApp,
  createReadyVideo,
  registerConfirmAndLogin,
  resetThrottler,
  startUpload,
  type AuthenticatedUser,
  type StartedUpload,
  type VideosE2eContext,
} from './helpers/videos-e2e.helper';

describe('GET /videos/:publicId/stream (e2e)', () => {
  let ctx: VideosE2eContext;
  let owner: AuthenticatedUser;
  let ready: StartedUpload;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp({ withProcessing: true });
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx);
    owner = await registerConfirmAndLogin(ctx, 'owner@example.com');
    ready = await createReadyVideo(ctx, owner);
  }, 120000);

  afterAll(async () => {
    await abortOpenUploads(ctx);
    await ctx.close();
  });

  beforeEach(() => {
    resetThrottler(ctx);
  });

  function stream(publicId: string) {
    return request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}/stream`)
      .redirects(0);
  }

  describe('ready video', () => {
    it('should redirect without a token to a presigned URL', async () => {
      const res = await stream(ready.public_id);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('X-Amz-Signature');
    });

    it('should let the target answer a range request with 206 and exactly 100 bytes', async () => {
      const res = await stream(ready.public_id);

      const response = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-99' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toMatch(/^bytes 0-99\//);
      expect((await response.arrayBuffer()).byteLength).toBe(100);
    });

    it('should not throttle fifteen consecutive requests', async () => {
      for (let i = 0; i < 15; i++) {
        expect((await stream(ready.public_id)).status).toBe(302);
      }
    });
  });

  describe('not visible', () => {
    it('should answer 404 for draft, processing, failed, unknown and malformed ids', async () => {
      const repo = ctx.dataSource.getRepository(Video);
      const draft = await startUpload(ctx, owner);
      const processing = await startUpload(ctx, owner);
      await repo.update(processing.id, { status: VideoStatus.PROCESSING });
      const failed = await startUpload(ctx, owner);
      await repo.update(failed.id, {
        status: VideoStatus.FAILED,
        processing_error: 'x',
      });

      for (const id of [
        draft.public_id,
        processing.public_id,
        failed.public_id,
        generatePublicId(),
        'abc',
      ]) {
        const res = await stream(id);
        expect(res.status).toBe(404);
        expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
      }
    });
  });
});
