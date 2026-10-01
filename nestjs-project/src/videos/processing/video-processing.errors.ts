/** Failures that retrying cannot fix: the processor turns them into UnrecoverableError. */
export class PermanentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}
