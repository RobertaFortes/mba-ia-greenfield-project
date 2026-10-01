import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestVideoOptions {
  seconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  withAudio?: boolean;
  /** Generates a file with an audio stream only. */
  audioOnly?: boolean;
  /** Constant video bitrate such as `9M`, to get a file of a predictable size. */
  constantBitrate?: string;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
    });
  });
}

/** Generates a short, valid MP4 (H.264 + optional AAC) with ffmpeg's synthetic sources. */
export async function generateTestVideo(
  options: TestVideoOptions = {},
): Promise<Buffer> {
  const {
    seconds = 3,
    width = 320,
    height = 240,
    fps = 25,
    withAudio = true,
    audioOnly = false,
    constantBitrate,
  } = options;
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-test-video-'));
  const output = join(dir, 'video.mp4');
  try {
    const video = [
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${seconds}:size=${width}x${height}:rate=${fps}`,
    ];
    const audio = [
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
    ];
    const args = audioOnly
      ? [...audio, '-c:a', 'aac', output]
      : [
          ...video,
          ...(withAudio ? audio : []),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          ...(constantBitrate
            ? [
                '-b:v',
                constantBitrate,
                '-minrate',
                constantBitrate,
                '-maxrate',
                constantBitrate,
                '-bufsize',
                constantBitrate,
                '-x264-params',
                'nal-hrd=cbr',
              ]
            : []),
          ...(withAudio ? ['-c:a', 'aac'] : []),
          '-movflags',
          '+faststart',
          output,
        ];
    await runFfmpeg(args);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
