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

interface PublicBody {
  public_id: string;
  title: string;
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  bitrate: number;
  fps: number;
  thumbnail_url: string;
  created_at: string;
  processed_at: string;
  error?: string;
}

describe('GET /videos/:publicId (e2e)', () => {
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

  function getVideo(publicId: string) {
    return request(ctx.app.getHttpServer()).get(`/videos/${publicId}`);
  }

  describe('ready video', () => {
    it('should be visible without a token, with its extracted metadata', async () => {
      const res = await getVideo(ready.public_id);
      const body = res.body as PublicBody;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        public_id: ready.public_id,
        title: 'clip',
        width: 640,
        height: 360,
        video_codec: 'h264',
        fps: 25,
      });
      expect(body.duration_seconds).toBeCloseTo(10, 0);
      expect(body.bitrate).toBeGreaterThan(0);
      expect(body.thumbnail_url).toBeTruthy();
      expect(body.created_at).toBeTruthy();
      expect(body.processed_at).toBeTruthy();
      expect(body).not.toHaveProperty('storage_key');
    });

    it('should serve the thumbnail URL as a JPEG', async () => {
      const body = (await getVideo(ready.public_id)).body as PublicBody;

      const response = await fetch(body.thumbnail_url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
    });

    it('should not throttle ten consecutive requests', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await getVideo(ready.public_id);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('not visible', () => {
    it('should answer 404 for draft, processing, failed, unknown and malformed ids', async () => {
      const draft = await startUpload(ctx, owner);
      const repo = ctx.dataSource.getRepository(Video);
      const processing = await startUpload(ctx, owner);
      await repo.update(processing.id, { status: VideoStatus.PROCESSING });
      const failed = await startUpload(ctx, owner);
      await repo.update(failed.id, {
        status: VideoStatus.FAILED,
        processing_error: 'x',
      });

      const ids = [
        draft.public_id,
        processing.public_id,
        failed.public_id,
        generatePublicId(),
        'abc',
      ];
      for (const id of ids) {
        const res = await getVideo(id);
        expect(res.status).toBe(404);
        expect((res.body as PublicBody).error).toBe('VIDEO_NOT_FOUND');
      }
    });
  });
});
