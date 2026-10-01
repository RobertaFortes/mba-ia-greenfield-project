import { calculatePartPlan } from './upload-parts.util';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('calculatePartPlan', () => {
  it('should split 10 GiB into 80 parts at the default 128 MiB', () => {
    expect(calculatePartPlan(10 * GIB, 128 * MIB)).toEqual({
      partSizeBytes: 128 * MIB,
      totalParts: 80,
    });
  });

  it('should use a single part for a file smaller than the part size', () => {
    expect(calculatePartPlan(1, 128 * MIB)).toEqual({
      partSizeBytes: 128 * MIB,
      totalParts: 1,
    });
  });

  it('should round the last partial part up', () => {
    expect(calculatePartPlan(128 * MIB + 1, 128 * MIB).totalParts).toBe(2);
  });

  it('should keep an exact multiple without an extra part', () => {
    expect(calculatePartPlan(3 * 5 * MIB, 5 * MIB).totalParts).toBe(3);
  });

  it('should raise the part size so the plan never exceeds 10000 parts', () => {
    // Pure function: sizes above the 10 GiB product limit still obey the S3 cap.
    const plan = calculatePartPlan(100 * GIB, 5 * MIB);

    expect(plan.totalParts).toBeLessThanOrEqual(10000);
    expect(plan.partSizeBytes).toBeGreaterThan(5 * MIB);
    expect(plan.partSizeBytes * plan.totalParts).toBeGreaterThanOrEqual(
      100 * GIB,
    );
  });

  it('should be exactly 10000 parts at the boundary', () => {
    expect(calculatePartPlan(10000 * 5 * MIB, 5 * MIB)).toEqual({
      partSizeBytes: 5 * MIB,
      totalParts: 10000,
    });
  });
});
