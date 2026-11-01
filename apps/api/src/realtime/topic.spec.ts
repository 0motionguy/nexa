/**
 * Topic grammar spec — server side (source of truth).
 *
 * The marked shared-vectors block below is byte-identical with
 * `packages/realtime-client/src/topic.spec.ts`.
 * CI-checkable: extract both regions and diff. If you change grammar
 * behavior here, port the vector change to the client suite in the SAME
 * commit — one side passing while the other fails IS the drift alarm.
 */

import { describe, expect, it } from 'vitest';

import {
  asTopic,
  format,
  isValid,
  parse,
  parsePrivKindTopic,
  parsePrivTopic,
  privOrdersTopic,
} from './topic.js';

/* ══════════════════════ BEGIN SHARED VECTORS ══════════════════════
 * Byte-identical in BOTH suites:
 *   - apps/api/src/realtime/topic.spec.ts          (server — source of truth)
 *   - packages/realtime-client/src/topic.spec.ts   (hand-mirrored client)
 */

interface Expected {
  kind: string;
  venue: string;
  symbol: string;
  interval?: string;
  depth?: number;
}

const VALID: ReadonlyArray<[string, Expected]> = [
  ['ticker:hl:BTC', { kind: 'ticker', venue: 'hl', symbol: 'BTC' }],
  ['ticker:hl:@107', { kind: 'ticker', venue: 'hl', symbol: '@107' }],
  ['ticker:hl:PURR/USDC', { kind: 'ticker', venue: 'hl', symbol: 'PURR/USDC' }],
  // HIP-3 builder-dex coins are literally `<dex>:<coin>` — the WS1 tolerant
  // middle-join exists for exactly these.
  ['ticker:hl:xyz:SKHX', { kind: 'ticker', venue: 'hl', symbol: 'xyz:SKHX' }],
  ['ticker:jup:So11111111111111111111111111111111111111112',
    { kind: 'ticker', venue: 'jup', symbol: 'So11111111111111111111111111111111111111112' }],
  ['trades:hl:ETH', { kind: 'trades', venue: 'hl', symbol: 'ETH' }],
  ['stock:pyth:AAPL', { kind: 'stock', venue: 'pyth', symbol: 'AAPL' }],
  ['meme:helius:BONK', { kind: 'meme', venue: 'helius', symbol: 'BONK' }],
  ['predictions:pm:71321045123456789',
    { kind: 'predictions', venue: 'pm', symbol: '71321045123456789' }],
  ['candle:hl:ETH:15m', { kind: 'candle', venue: 'hl', symbol: 'ETH', interval: '15m' }],
  ['candle:hl:xyz:SKHX:1M', { kind: 'candle', venue: 'hl', symbol: 'xyz:SKHX', interval: '1M' }],
  ['book:hl:BTC:25', { kind: 'book', venue: 'hl', symbol: 'BTC', depth: 25 }],
  ['book:hl:xyz:SKHX:50', { kind: 'book', venue: 'hl', symbol: 'xyz:SKHX', depth: 50 }],
  ['book:pm:71321045123456789:100',
    { kind: 'book', venue: 'pm', symbol: '71321045123456789', depth: 100 }],
];

const INVALID: readonly string[] = [
  '',
  'ticker',
  'ticker:hl',
  'nope:hl:BTC',
  'ticker:nyse:AAPL',
  'ticker::BTC',
  'ticker:hl:',
  'candle:hl:BTC', // param kinds REQUIRE their param
  'candle:hl:BTC:7x',
  'candle:hl::15m',
  'book:hl:BTC',
  'book:hl:BTC:0',
  'book:hl:BTC:-5',
  'book:hl:BTC:2.5',
  'book:hl:BTC:junk',
  'book:hl::25',
  'priv:u_1:orders', // priv namespace is NOT the public grammar
];

// Acceptance sets — the drift guard that catches a venue/kind present on one
// side only ('nexa' is a provenance label, never subscribable).
const ACCEPTED_VENUES = ['hl', 'pm', 'pyth', 'helius', 'jup', 'yahoo', 'tv', 'rest'] as const;
const REJECTED_VENUES = ['nexa', 'nyse', 'HL'] as const;
const ACCEPTED_KINDS = ['ticker', 'candle', 'book', 'trades', 'stock', 'meme', 'predictions'] as const;

describe('parse — accepted vectors (mirror contract)', () => {
  it.each([...VALID])('parses %j', (raw, expected) => {
    expect(parse(raw)).toEqual(expected);
    expect(isValid(raw)).toBe(true);
  });
});

describe('parse — rejected vectors (mirror contract)', () => {
  it.each([...INVALID])('rejects %j', (raw) => {
    expect(parse(raw)).toBeNull();
    expect(isValid(raw)).toBe(false);
  });
});

describe('round-trip', () => {
  it.each([...VALID])('format(parse(%j)) returns the input', (raw) => {
    expect(format(parse(raw)!)).toBe(raw);
  });

  it('normalizes non-canonical numeric depth', () => {
    const p = parse('book:hl:BTC:025');
    expect(p).toEqual({ kind: 'book', venue: 'hl', symbol: 'BTC', depth: 25 });
    expect(format(p!)).toBe('book:hl:BTC:25');
  });
});

describe('tolerant middle-join (WS1)', () => {
  it('folds trailing segments into the symbol for non-param kinds (documented loosening)', () => {
    // Pre-WS1 the grammar rejected params on non-param kinds; post-WS1 the
    // whole tail IS the symbol. Intentional — HIP-3 symbols carry `:`.
    expect(parse('ticker:hl:BTC:junk')).toEqual({ kind: 'ticker', venue: 'hl', symbol: 'BTC:junk' });
  });

  it('peels the validated param off the END for candle/book', () => {
    expect(parse('candle:hl:a:b:c:5m')).toEqual({ kind: 'candle', venue: 'hl', symbol: 'a:b:c', interval: '5m' });
    expect(parse('book:hl:a:b:c:10')).toEqual({ kind: 'book', venue: 'hl', symbol: 'a:b:c', depth: 10 });
  });
});

describe('acceptance sets (drift guard)', () => {
  it.each([...ACCEPTED_VENUES])('accepts venue %s', (v) => {
    expect(isValid(`ticker:${v}:X`)).toBe(true);
  });
  it.each([...REJECTED_VENUES])('rejects venue %s', (v) => {
    expect(isValid(`ticker:${v}:X`)).toBe(false);
  });
  it.each([...ACCEPTED_KINDS])('accepts kind %s', (k) => {
    const raw = k === 'candle' ? `${k}:hl:X:1m` : k === 'book' ? `${k}:hl:X:10` : `${k}:hl:X`;
    expect(isValid(raw)).toBe(true);
  });
});

describe('caps', () => {
  it('symbol ≤ 96 (plain and joined), depth ≤ 1000, raw ≤ 256', () => {
    const max = 'A'.repeat(96);
    expect(parse(`ticker:hl:${max}`)).toEqual({ kind: 'ticker', venue: 'hl', symbol: max });
    expect(parse(`ticker:hl:${max}A`)).toBeNull();

    const joined = `${'A'.repeat(90)}:${'B'.repeat(5)}`; // 96 incl. the colon
    expect(parse(`book:hl:${joined}:25`)).toEqual({ kind: 'book', venue: 'hl', symbol: joined, depth: 25 });
    expect(parse(`book:hl:${joined}B:25`)).toBeNull();

    expect(parse('book:hl:BTC:1000')).toEqual({ kind: 'book', venue: 'hl', symbol: 'BTC', depth: 1000 });
    expect(parse('book:hl:BTC:1001')).toBeNull();

    expect(parse('x'.repeat(257))).toBeNull();
  });
});

describe('format — param kinds demand their param', () => {
  it('throws for candle without interval / book without depth', () => {
    expect(() => format({ kind: 'candle', venue: 'hl', symbol: 'ETH' })).toThrow(/interval/);
    expect(() => format({ kind: 'book', venue: 'hl', symbol: 'ETH' })).toThrow(/depth/);
  });
});

describe('privOrdersTopic', () => {
  it('templates priv:<userId>:orders', () => {
    expect(privOrdersTopic('u_1')).toBe('priv:u_1:orders');
  });
  it('throws on empty userId', () => {
    expect(() => privOrdersTopic('')).toThrow(/userId required/);
  });
});

/* ══════════════════════ END SHARED VECTORS ══════════════════════ */

describe('asTopic (server-only)', () => {
  it('brands a valid raw string', () => {
    expect(asTopic('ticker:hl:BTC')).toBe('ticker:hl:BTC');
  });
  it('throws on an invalid one', () => {
    expect(() => asTopic('ticker:hl')).toThrow(/invalid topic/);
  });
});

describe('priv ACL helpers (server-only)', () => {
  it('parsePrivTopic splits userId / rest at the FIRST colon', () => {
    expect(parsePrivTopic('priv:u_1:orders')).toEqual({ userId: 'u_1', rest: 'orders' });
    expect(parsePrivTopic('priv:u_1:orders:extra')).toEqual({ userId: 'u_1', rest: 'orders:extra' });
  });

  it('returns null for non-priv topics so callers fall back to the public grammar', () => {
    expect(parsePrivTopic('ticker:hl:BTC')).toBeNull();
  });

  it('malformed priv topics resolve to deniable empties, never to public fallback', () => {
    expect(parsePrivTopic('priv:u_1')).toEqual({ userId: 'u_1', rest: '' });
    expect(parsePrivTopic('priv:')).toEqual({ userId: '', rest: '' });
  });

  it('parsePrivKindTopic accepts only known kinds with a non-empty userId', () => {
    expect(parsePrivKindTopic('priv:u_1:orders')).toEqual({ userId: 'u_1', kind: 'orders' });
    expect(parsePrivKindTopic('priv:u_1:account')).toEqual({ userId: 'u_1', kind: 'account' });
    expect(parsePrivKindTopic('priv:u_1:fills')).toEqual({ userId: 'u_1', kind: 'fills' });
    expect(parsePrivKindTopic('priv::orders')).toBeNull();
    expect(parsePrivKindTopic('priv:u_1:alerts')).toBeNull();
    expect(parsePrivKindTopic('priv:u_1:orders:extra')).toBeNull();
    expect(parsePrivKindTopic('ticker:hl:BTC')).toBeNull();
  });

  it('privOrdersTopic output round-trips through parsePrivKindTopic', () => {
    expect(parsePrivKindTopic(privOrdersTopic('u_1'))).toEqual({ userId: 'u_1', kind: 'orders' });
  });
});
