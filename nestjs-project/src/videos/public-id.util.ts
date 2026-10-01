import { randomBytes } from 'node:crypto';

const PUBLIC_ID_LENGTH = 11;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** 8 random bytes in base64url = 11 characters, 64 bits of entropy. */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

export function isValidPublicId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === PUBLIC_ID_LENGTH &&
    PUBLIC_ID_PATTERN.test(value)
  );
}
