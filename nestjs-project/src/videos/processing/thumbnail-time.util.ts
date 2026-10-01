const MAX_THUMBNAIL_SECOND = 1;
const THUMBNAIL_FRACTION = 0.1;

/**
 * Second to grab the thumbnail from: 10% into the video, never later than 1s,
 * so short clips do not seek past their end. Invalid durations fall back to 0.
 */
export function calculateThumbnailTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(MAX_THUMBNAIL_SECOND, THUMBNAIL_FRACTION * durationSeconds);
}
