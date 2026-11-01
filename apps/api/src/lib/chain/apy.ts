import { ChainError } from './units.js';

export function apyToBps(value: unknown): number | null {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const decimal = n > 1 ? n / 100 : n;
  return Math.round(decimal * 10000);
}

export function apyUnavailable(provider: string, cause?: unknown): ChainError {
  return new ChainError('apy_unavailable', `${provider} APY unavailable`, cause);
}
