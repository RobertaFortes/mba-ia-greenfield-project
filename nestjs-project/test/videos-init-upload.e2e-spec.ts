import request from 'supertest';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  abortOpenUploads,
  bootstrapVideosApp,
  registerConfirmAndLogin,
  resetThrottler,
  type AuthenticatedUser,
  type VideosE2eContext,
} from './helpers/videos-e2e.helper';

const MIB = 1024 * 1024;

interface InitUploadBody {
  id: string;
  public_id: string;
  status: string;
  title: string;
  upload_id: string;
  part_size_bytes: number;
  total_parts: number;
  url_expires_in_seconds: number;
  parts: { part_number: number; url: string }[];
  error?: string;
}

const validBody = {
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: 11 * MIB,
};

describe('POST /videos (e2e)', () => {
  let ctx: VideosE2eContext;
  let user: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx);
    user = await registerConfirmAndLogin(ctx, 'uploader@example.com');
  });

  afterEach(async () => {
    await abortOpenUploads(ctx);
  });

  function init(body: unknown, token: string | null = user.accessToken) {
    const req = request(ctx.app.getHttpServer()).post('/videos');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body as object);
  }

  describe('start upload — success', () => {
    it('should return a draft with one presigned URL per part', async () => {
      const res = await init(validBody);
      const body = res.body as InitUploadBody;

      expect(res.status).toBe(201);
      expect(body).toMatchObject({
        status: VideoStatus.DRAFT,
        title: 'clip',
        total_parts: 3,
        part_size_bytes: 5 * MIB,
        url_expires_in_seconds: 3600,
      });
      expect(body.id).toBeDefined();
      expect(body.upload_id).toBeDefined();
      expect(body.public_id).toHaveLength(11);
      expect(body.parts).toHaveLength(3);
      expect(body.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    });

    it('should default the title to the filename without extension', async () => {
      const res = await init({
        filename: 'my holiday.mov',
        content_type: 'video/quicktime',
        size_bytes: MIB,
      });

      expect(res.status).toBe(201);
      expect((res.body as InitUploadBody).title).toBe('my holiday');
    });

    it("should store the draft in the caller's channel and accept bytes on a part URL", async () => {
      const res = await init(validBody);
      const body = res.body as InitUploadBody;

      const row = await ctx.dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: body.public_id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.channel_id).toBe(user.channelId);

      const put = await fetch(body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(5 * MIB),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();
    });

    it('should never repeat a public id across calls', async () => {
      const first = await init(validBody);
      const second = await init(validBody);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((first.body as InitUploadBody).public_id).not.toBe(
        (second.body as InitUploadBody).public_id,
      );
    });
  });

  describe('start upload — size and type limits', () => {
    it('should accept 10 GiB and plan 80 parts at the default part size', async () => {
      const big = await bootstrapVideosApp({
        video: { uploadPartSizeBytes: 128 * MIB },
      });
      try {
        const bigUser = await registerConfirmAndLogin(
          big,
          'bigfile@example.com',
        );
        const res = await request(big.app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${bigUser.accessToken}`)
          .send({ ...validBody, size_bytes: 10 * 1024 * MIB });

        expect(res.status).toBe(201);
        expect((res.body as InitUploadBody).total_parts).toBe(80);
        await abortOpenUploads(big);
      } finally {
        await big.close();
      }
    });

    it('should reject a file above 10 GiB', async () => {
      const res = await init({ ...validBody, size_bytes: 10 * 1024 * MIB + 1 });

      expect(res.status).toBe(400);
      expect((res.body as InitUploadBody).error).toBe('VIDEO_FILE_TOO_LARGE');
    });

    it('should reject an unsupported content type', async () => {
      const res = await init({ ...validBody, content_type: 'video/avi' });

      expect(res.status).toBe(400);
      expect((res.body as InitUploadBody).error).toBe(
        'VIDEO_UNSUPPORTED_CONTENT_TYPE',
      );
    });
  });

  describe('start upload — validation and authentication', () => {
    it('should reject unknown properties and invalid sizes', async () => {
      const extra = await init({ ...validBody, foo: 'bar' });
      const zero = await init({ ...validBody, size_bytes: 0 });
      const text = await init({ ...validBody, size_bytes: 'abc' });

      for (const res of [extra, zero, text]) {
        expect(res.status).toBe(400);
        expect((res.body as InitUploadBody).error).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject a request without a bearer token', async () => {
      const res = await init(validBody, null);

      expect(res.status).toBe(401);
    });
  });
});
