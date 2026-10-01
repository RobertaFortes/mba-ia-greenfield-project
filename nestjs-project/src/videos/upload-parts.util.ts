/** S3 allows at most 10000 parts per multipart upload. */
export const MAX_UPLOAD_PARTS = 10000;

export interface PartPlan {
  partSizeBytes: number;
  totalParts: number;
}

/**
 * Picks the part size: the configured size, raised when the file would need
 * more than 10000 parts at that size.
 */
export function calculatePartPlan(
  sizeBytes: number,
  configuredPartSizeBytes: number,
): PartPlan {
  const partSizeBytes = Math.max(
    configuredPartSizeBytes,
    Math.ceil(sizeBytes / MAX_UPLOAD_PARTS),
  );
  return {
    partSizeBytes,
    totalParts: Math.ceil(sizeBytes / partSizeBytes),
  };
}
