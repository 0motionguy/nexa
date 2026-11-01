/**
 * Tiny formatting helpers shared across the in-memory modules.
 * Kept separate from postgres/_shared.ts because in-memory has no row mappers.
 */

import { randomUUID } from 'node:crypto';

export { round2 } from '../../lib/money.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function money(v: number): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ref(): string {
  return '0x' + randomUUID().replace(/-/g, '').slice(0, 8) + '..' + randomUUID().slice(0, 4);
}
