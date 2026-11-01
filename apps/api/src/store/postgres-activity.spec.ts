import { describe, expect, it } from 'vitest';
import { _activityFromTxForTests as ledgerActivityFromTx } from './postgres/ledger.js';
import { _activityFromTxForTests as agentActivityFromTx } from './postgres/agents.js';

type LedgerRow = Parameters<typeof ledgerActivityFromTx>[0];
type AgentRow = Parameters<typeof agentActivityFromTx>[0];

function txRow(patch: Partial<LedgerRow & AgentRow>): LedgerRow & AgentRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    agentId: null,
    kind: 'in',
    status: 'confirmed',
    title: 'Top up',
    subtitle: 'JUST NOW',
    amountUsd: '10.000000',
    counterparty: null,
    txHash: 'idem:test',
    chain: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...patch,
  } as LedgerRow & AgentRow;
}

describe('Postgres activity replay reconstruction', () => {
  it('keeps LEGACY kind:in Earn deposit replays as debits via the title fallback', () => {
    const activity = ledgerActivityFromTx(txRow({ title: 'Moved to Earn', kind: 'in' }));

    expect(activity.a).toBe('-$10.00');
    expect(activity.pos).toBeUndefined();
  });

  it('treats new kind:out Earn deposit rows as debits from kind alone', () => {
    const activity = ledgerActivityFromTx(txRow({ title: 'Moved to Earn', kind: 'out' }));

    expect(activity.a).toBe('-$10.00');
    expect(activity.pos).toBeUndefined();
    expect(activity.k).toBe('out');
  });

  it('keeps agent budget and x402 replay rows as debits unless they are defunds', () => {
    const funded = agentActivityFromTx(txRow({ title: 'Funded ReplayBot', kind: 'agent' }));
    const approved = agentActivityFromTx(txRow({ title: 'Released $10.00 · api access', kind: 'agent' }));
    const paid = agentActivityFromTx(txRow({ title: 'Paid api.exa.ai', kind: 'x402' }));
    const defunded = agentActivityFromTx(txRow({ title: 'Pulled back · ReplayBot', kind: 'agent' }));

    expect(funded.a).toBe('-$10.00');
    expect(approved.a).toBe('-$10.00');
    expect(paid.a).toBe('-$10.00');
    expect(defunded.a).toBe('+$10.00');
    expect(defunded.pos).toBe(true);
  });
});
