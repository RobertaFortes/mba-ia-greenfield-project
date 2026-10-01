import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '134217728',
    10,
  ),
  uploadUrlExpirationSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
  playbackUrlExpirationSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_EXPIRATION_SECONDS || '300',
    10,
  ),
  processingTimeoutSeconds: parseInt(
    process.env.VIDEO_PROCESSING_TIMEOUT_SECONDS || '1800',
    10,
  ),
}));
