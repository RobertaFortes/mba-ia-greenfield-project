import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process';

export const VIDEO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
};

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export const VIDEO_FILE_EXTENSIONS: Record<
  (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number],
  string
> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
};

export const VIDEO_TITLE_MAX_LENGTH = 200;
export const PUBLIC_ID_MAX_ATTEMPTS = 5;
