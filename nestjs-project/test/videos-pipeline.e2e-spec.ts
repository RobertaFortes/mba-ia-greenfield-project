import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import {
  abortOpenUploads,
  bootstrapVideosApp,
  largeTestVideo,
  registerConfirmAndLogin,
  resetThrottler,
  startUpload,
  uploadFile,
  waitForStatus,
  type AuthenticatedUser,
  type StartedUpload,
  type VideosE2eContext,
} from './helpers/videos-e2e.helper';

interface PublicBody {
  duration_seconds: number;
  width: number;
  height: number;
  thumbnail_url: string;
}

describe('Video upload and processing pipeline (e2e)', () => {
  let ctx: VideosE2eContext;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp({ withProcessing: true });
  }, 60000);

  afterAll(async () => {
    await abortOpenUploads(ctx);
    await ctx.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx);
    owner = await registerConfirmAndLogin(ctx, 'owner@example.com');
  });

  function complete(upload: StartedUpload, parts: unknown) {
    return request(ctx.app.getHttpServer())
      .post(`/videos/${upload.public_id}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ parts });
  }

  it('should take a generated MP4 from upload to ready, then serve metadata, stream and download', async () => {
    const file = await largeTestVideo();
    const upload = await startUpload(ctx, owner, {
      filename: 'holiday.mp4',
      content_type: 'video/mp4',
      size_bytes: file.length,
    });
    expect(upload.total_parts).toBe(3);
    const parts = await uploadFile(upload, file);

    const completed = await complete(upload, parts);
    expect(completed.status).toBe(202);

    const settled = await waitForStatus(ctx, owner, upload.public_id, 'ready');
    expect(settled.processing_error).toBeNull();

    const meta = await request(ctx.app.getHttpServer()).get(
      `/videos/${upload.public_id}`,
    );
    const body = meta.body as PublicBody;
    expect(meta.status).toBe(200);
    expect(body.duration_seconds).toBeCloseTo(10, 0);
    expect(body.width).toBe(640);
    expect(body.height).toBe(360);
    const thumbnail = await fetch(body.thumbnail_url);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');

    const stream = await request(ctx.app.getHttpServer())
      .get(`/videos/${upload.public_id}/stream`)
      .redirects(0);
    expect(stream.status).toBe(302);
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const download = await request(ctx.app.getHttpServer())
      .get(`/videos/${upload.public_id}/download`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .redirects(0);
    expect(download.status).toBe(302);
    const attachment = await fetch(download.headers.location, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(attachment.headers.get('content-disposition')).toBe(
      'attachment; filename="holiday.mp4"',
    );
  }, 120000);

  it('should end failed with a processing error, and hide the video publicly, when the object is not a video', async () => {
    const garbage = Buffer.alloc(11 * 1024 * 1024, 1);
    const upload = await startUpload(ctx, owner, {
      filename: 'fake.mp4',
      content_type: 'video/mp4',
      size_bytes: garbage.length,
    });
    const parts = await uploadFile(upload, garbage);
    await complete(upload, parts).expect(202);

    const settled = await waitForStatus(ctx, owner, upload.public_id, 'failed');

    expect(settled.processing_error).toBeTruthy();
    const meta = await request(ctx.app.getHttpServer()).get(
      `/videos/${upload.public_id}`,
    );
    expect(meta.status).toBe(404);
  }, 120000);

  it("should answer 404 when another user asks for the first user's upload session", async () => {
    const upload = await startUpload(ctx, owner);
    const intruder = await registerConfirmAndLogin(ctx, 'intruder@example.com');

    const res = await request(ctx.app.getHttpServer())
      .get(`/videos/${upload.public_id}/upload`)
      .set('Authorization', `Bearer ${intruder.accessToken}`);

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    await abortOpenUploads(ctx);
  });

  it('should remove a fresh draft and its multipart upload when aborted', async () => {
    const upload = await startUpload(ctx, owner);

    await request(ctx.app.getHttpServer())
      .delete(`/videos/${upload.public_id}/upload`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

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
});
