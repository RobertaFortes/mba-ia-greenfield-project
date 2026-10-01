const FALLBACK_FILENAME = 'video';

/**
 * Makes an uploaded filename safe for a `Content-Disposition` header: drops
 * quotes, control characters and path separators.
 */
export function toSafeDownloadFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_FILENAME;
}
