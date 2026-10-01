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

describe('GET /videos/:publicId/download (e2e)', () => {
  let ctx: VideosE2eContext;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let ready: StartedUpload;
  let unsafe: StartedUpload;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp({ withProcessing: true });
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx);
    owner = await registerConfirmAndLogin(ctx, 'owner@example.com');
    other = await registerConfirmAndLogin(ctx, 'other@example.com');
    ready = await createReadyVideo(ctx, owner, 'holiday clip.mp4');
    unsafe = await createReadyVideo(ctx, owner, 'we"ird/..\\name.mp4');
  }, 180000);

  afterAll(async () => {
    await abortOpenUploads(ctx);
    await ctx.close();
  });

  beforeEach(() => {
    resetThrottler(ctx);
  });

  function download(publicId: string, token: string | null) {
    const req = request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}/download`)
      .redirects(0);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  describe('authenticated', () => {
    it('should require a token', async () => {
      const res = await download(ready.public_id, null);

      expect(res.status).toBe(401);
    });

    it('should redirect any logged-in user to an attachment URL with the original filename', async () => {
      const res = await download(ready.public_id, other.accessToken);

      expect(res.status).toBe(302);
      const response = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="holiday clip.mp4"',
      );
    });

    it('should strip quotes and path separators from unsafe filenames', async () => {
      const res = await download(unsafe.public_id, owner.accessToken);

      const response = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-9' },
      });
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';

      expect(filename).toBe('weird..name.mp4');
      expect(filename).not.toMatch(/["\\/]/);
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
        const res = await download(id, owner.accessToken);
        expect(res.status).toBe(404);
        expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
      }
    });
  });
});
