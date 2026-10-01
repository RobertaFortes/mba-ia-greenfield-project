export class NoVideoStreamError extends Error {
  constructor() {
    super('The file has no video stream');
    this.name = 'NoVideoStreamError';
  }
}

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

export interface ProbeOutput {
  format?: {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams?: ProbeStream[];
}

export interface ParsedProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  bitrate: number | null;
  formatName: string | null;
  fps: number | null;
  raw: ProbeOutput;
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ffprobe reports frame rates as a fraction such as "30000/1001"; "0/0" means unknown. */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !denominator) return null;
  const rate = numerator / denominator;
  return rate > 0 ? rate : null;
}

export function parseProbeOutput(probe: ProbeOutput): ParsedProbe {
  const streams = probe.streams ?? [];
  // Cover art in audio files shows up as a "video" stream flagged attached_pic.
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  if (!video) throw new NoVideoStreamError();
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const durationSeconds =
    toNumber(probe.format?.duration) ?? toNumber(video.duration) ?? 0;

  return {
    durationSeconds,
    width: video.width ?? 0,
    height: video.height ?? 0,
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
    bitrate: toNumber(probe.format?.bit_rate),
    formatName: probe.format?.format_name ?? null,
    fps:
      parseFrameRate(video.avg_frame_rate) ??
      parseFrameRate(video.r_frame_rate),
    raw: probe,
  };
}
