import { generatePublicId, isValidPublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not repeat across a large sample', () => {
    const sample = new Set(
      Array.from({ length: 5000 }, () => generatePublicId()),
    );
    expect(sample.size).toBe(5000);
  });
});

describe('isValidPublicId', () => {
  it('should accept a generated id', () => {
    expect(isValidPublicId(generatePublicId())).toBe(true);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'abcdefghijkl'],
    ['invalid character', 'abcdefghij!'],
    ['padding character', 'abcdefghij='],
    ['empty string', ''],
    ['path traversal', '../../etc/p'],
  ])('should reject %s', (_label, value) => {
    expect(isValidPublicId(value)).toBe(false);
  });

  it('should reject non-string values', () => {
    expect(isValidPublicId(undefined)).toBe(false);
    expect(isValidPublicId(12345678901)).toBe(false);
  });
});
