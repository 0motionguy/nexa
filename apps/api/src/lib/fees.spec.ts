import { describe, expect, it } from 'vitest';
import { recordFee, summarizeFees } from './fees.js';

describe('fees tracker', () => {
  it('keeps fractional builder-fee bps', () => {
    const ev = recordFee({
      userId: 'fee_fraction_user',
      venue: 'hyperliquid',
      kind: 'builder',
      notionalUsd: 100,
      rateBps: 2.5,
    });

    expect(ev.rateBps).toBe(2.5);
    expect(ev.feeUsd).toBe(0.025);
  });

  it('does not count unattempted demo fees as collected revenue', () => {
    const before = summarizeFees(100).totalFeeUsd;
    recordFee({
      userId: 'fee_demo_user',
      venue: 'jupiter',
      kind: 'platform',
      notionalUsd: 10_000,
      rateBps: 100,
      attempted: false,
    });

    expect(summarizeFees(100).totalFeeUsd).toBe(before);
  });
});
