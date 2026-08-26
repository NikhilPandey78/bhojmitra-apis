import crypto from 'node:crypto';

export function referenceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

export function handleError(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : 'Unexpected server error' };
}
