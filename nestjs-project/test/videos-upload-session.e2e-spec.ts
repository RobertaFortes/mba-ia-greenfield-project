import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import {
  abortOpenUploads,
  bootstrapVideosApp,
  DEFAULT_UPLOAD,
  MIB,
  partSizes,
  putPart,
  registerConfirmAndLogin,
  resetThrottler,
  startUpload,
  uploadAllParts,
  type AuthenticatedUser,
  type VideosE2eContext,
} from './helpers/videos-e2e.helper';

interface SessionBody {
  status: string;
  processing_error: string | null;
  upload_id: string | null;
  uploaded_parts: { part_number: number; size_bytes: number; etag: string }[];
  pending_parts: { part_number: number; url: string }[];
  error?: string;
}

describe('GET /videos/:publicId/upload (e2e)', () => {
  let ctx: VideosE2eContext;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx);
    owner = await registerConfirmAndLogin(ctx, 'owner@example.com');
  });

  afterEach(async () => {
    await abortOpenUploads(ctx);
  });

  function getSession(publicId: string, token: string | null) {
    const req = request(ctx.app.getHttpServer()).get(
      `/videos/${publicId}/upload`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  describe('draft', () => {
    it('should list uploaded and pending parts and accept the last part on the pending URL', async () => {
      const upload = await startUpload(ctx, owner);
      const sizes = partSizes(upload, DEFAULT_UPLOAD.size_bytes);
      await putPart(upload.parts[0].url, sizes[0]);
      await putPart(upload.parts[1].url, sizes[1]);

      const res = await getSession(upload.public_id, owner.accessToken);
      const body = res.body as SessionBody;

      expect(res.status).toBe(200);
      expect(body.uploaded_parts).toHaveLength(2);
      expect(body.uploaded_parts[0]).toEqual({
        part_number: 1,
        size_bytes: 5 * MIB,
        etag: expect.any(String) as string,
      });
      expect(body.pending_parts).toHaveLength(1);
      expect(body.pending_parts[0].part_number).toBe(3);
      const etag = await putPart(body.pending_parts[0].url, sizes[2]);
      expect(etag).toBeTruthy();
    });
  });

  describe('other states', () => {
    it('should report a processing video with empty arrays and a null upload id', async () => {
      const upload = await startUpload(ctx, owner);
      const parts = await uploadAllParts(upload);
      await request(ctx.app.getHttpServer())
        .post(`/videos/${upload.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ parts })
        .expect(202);

      const res = await getSession(upload.public_id, owner.accessToken);
      const body = res.body as SessionBody;

      expect(res.status).toBe(200);
      expect(body.status).not.toBe(VideoStatus.DRAFT);
      expect(body.uploaded_parts).toEqual([]);
      expect(body.pending_parts).toEqual([]);
      expect(body.upload_id).toBeNull();
    });

    it('should expose the processing error of a failed video', async () => {
      const upload = await startUpload(ctx, owner);
      await ctx.dataSource.getRepository(Video).update(upload.id, {
        status: VideoStatus.FAILED,
        processing_error: 'No video stream found',
      });

      const res = await getSession(upload.public_id, owner.accessToken);
      const body = res.body as SessionBody;

      expect(res.status).toBe(200);
      expect(body.status).toBe(VideoStatus.FAILED);
      expect(body.processing_error).toBe('No video stream found');
    });
  });

  describe('access control', () => {
    it('should answer 404 to another channel exactly as to an unknown id', async () => {
      const upload = await startUpload(ctx, owner);
      const intruder = await registerConfirmAndLogin(
        ctx,
        'intruder@example.com',
      );

      const foreign = await getSession(upload.public_id, intruder.accessToken);
      const unknown = await getSession('AAAAAAAAAAA', owner.accessToken);

      expect(foreign.status).toBe(404);
      expect((foreign.body as SessionBody).error).toBe('VIDEO_NOT_FOUND');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual(foreign.body);
    });

    it('should answer 404 to a malformed public id', async () => {
      const res = await getSession('abc', owner.accessToken);

      expect(res.status).toBe(404);
      expect((res.body as SessionBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('should reject a request without a bearer token', async () => {
      const upload = await startUpload(ctx, owner);

      const res = await getSession(upload.public_id, null);

      expect(res.status).toBe(401);
    });
  });
});
