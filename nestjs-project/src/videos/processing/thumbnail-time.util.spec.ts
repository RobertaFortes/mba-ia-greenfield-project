import { calculateThumbnailTime } from './thumbnail-time.util';

describe('calculateThumbnailTime', () => {
  it('should use 10% of a short clip', () => {
    expect(calculateThumbnailTime(0.5)).toBeCloseTo(0.05);
  });

  it('should cap at 1 second for long videos', () => {
    expect(calculateThumbnailTime(60)).toBe(1);
    expect(calculateThumbnailTime(3600)).toBe(1);
  });

  it('should reach the cap exactly at 10 seconds', () => {
    expect(calculateThumbnailTime(10)).toBe(1);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'should fall back to 0 for the invalid duration %s',
    (duration) => {
      expect(calculateThumbnailTime(duration)).toBe(0);
    },
  );
});
