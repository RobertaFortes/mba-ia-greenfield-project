import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { generateTestVideo } from '../../test/generate-test-video';
import { FfmpegService } from './ffmpeg.service';
import { NoVideoStreamError } from './probe-parser.util';

describe('FfmpegService (integration)', () => {
  let ffmpeg: FfmpegService;
  let storage: StorageService;
  let closeModule: () => Promise<void>;
  const keys: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();
    await module.init();
    ffmpeg = module.get(FfmpegService);
    storage = module.get(StorageService);
    closeModule = () => module.close();
  });

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await closeModule();
  });

  async function storeAndSign(body: Buffer, name: string): Promise<string> {
    const key = `test/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
    keys.push(key);
    await storage.putObject(key, body, 'video/mp4');
    return storage.presignInternalGet(key, 120);
  }

  it('should probe a generated 3-second video over a presigned URL', async () => {
    const url = await storeAndSign(
      await generateTestVideo({ seconds: 3, width: 320, height: 240, fps: 25 }),
      'probe.mp4',
    );

    const probe = await ffmpeg.probe(url);

    expect(probe.durationSeconds).toBeCloseTo(3, 0);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.fps).toBe(25);
    expect(probe.formatName).toContain('mp4');
  });

  it('should report no audio codec for a silent video', async () => {
    const url = await storeAndSign(
      await generateTestVideo({ withAudio: false }),
      'silent.mp4',
    );

    expect((await ffmpeg.probe(url)).audioCodec).toBeNull();
  });

  it('should reject a file that is not media', async () => {
    const url = await storeAndSign(
      Buffer.from('definitely not a video'),
      'text.mp4',
    );

    await expect(ffmpeg.probe(url)).rejects.toThrow();
  });

  it('should reject a file that only has an audio stream with NoVideoStreamError', async () => {
    const url = await storeAndSign(
      await generateTestVideo({ audioOnly: true }),
      'audio.mp4',
    );

    await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(NoVideoStreamError);
  });

  it('should extract a JPEG thumbnail no wider than 1280px', async () => {
    const url = await storeAndSign(
      await generateTestVideo({
        seconds: 2,
        width: 1920,
        height: 1080,
        fps: 10,
      }),
      'wide.mp4',
    );

    const jpeg = await ffmpeg.extractThumbnail(url, 0.2);

    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(jpeg.subarray(-2).toString('hex')).toBe('ffd9');
    // SOF0/SOF2 marker holds the frame size (height then width, big endian).
    const sof = jpeg.findIndex(
      (byte, i) =>
        byte === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2),
    );
    const width = jpeg.readUInt16BE(sof + 7);
    expect(width).toBeLessThanOrEqual(1280);
    expect(width).toBe(1280);
  });

  it('should kill a run that exceeds the timeout and reject', async () => {
    const hanging: Server = createServer(() => {
      // never answers: ffprobe waits on the socket until the timeout kills it
    });
    await new Promise<void>((resolve) =>
      hanging.listen(0, '127.0.0.1', resolve),
    );
    const { port } = hanging.address() as AddressInfo;
    const impatient = new FfmpegService({
      ...videoConfig(),
      processingTimeoutSeconds: 1,
    });

    const startedAt = Date.now();
    await expect(
      impatient.probe(`http://127.0.0.1:${port}/never.mp4`),
    ).rejects.toThrow(/timeout/);
    expect(Date.now() - startedAt).toBeLessThan(5000);

    hanging.closeAllConnections();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  });
});
