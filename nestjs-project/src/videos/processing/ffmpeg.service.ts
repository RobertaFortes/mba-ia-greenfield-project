import { spawn } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../../config/video.config';
import { parseProbeOutput } from './probe-parser.util';
import type { ParsedProbe, ProbeOutput } from './probe-parser.util';

const THUMBNAIL_MAX_WIDTH = 1280;
const STDERR_TAIL_BYTES = 2000;

export class FfmpegProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegProcessError';
  }
}

interface RunResult {
  stdout: Buffer;
}

@Injectable()
export class FfmpegService {
  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /** Reads metadata straight from `url` (HTTP range reads, nothing is downloaded). */
  async probe(url: string): Promise<ParsedProbe> {
    const { stdout } = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    let output: ProbeOutput;
    try {
      output = JSON.parse(stdout.toString('utf8')) as ProbeOutput;
    } catch {
      throw new FfmpegProcessError('ffprobe returned invalid JSON');
    }
    return parseProbeOutput(output);
  }

  /** Grabs one frame at `atSeconds`, scaled down to at most 1280px wide, as JPEG. */
  async extractThumbnail(url: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(atSeconds),
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ]);
    if (stdout.length === 0) {
      throw new FfmpegProcessError('ffmpeg produced no thumbnail frame');
    }
    return stdout;
  }

  /** No shell: arguments are passed as an array, so a URL can never inject options. */
  private run(command: string, args: string[]): Promise<RunResult> {
    const timeoutMs = this.config.processingTimeoutSeconds * 1000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new FfmpegProcessError(
            `${command} failed to start: ${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new FfmpegProcessError(
              `${command} exceeded the ${this.config.processingTimeoutSeconds}s timeout`,
            ),
          );
        } else if (code !== 0) {
          reject(
            new FfmpegProcessError(
              `${command} exited with code ${code}: ${stderr.trim()}`,
            ),
          );
        } else {
          resolve({ stdout: Buffer.concat(out) });
        }
      });
    });
  }
}
