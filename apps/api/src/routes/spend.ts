import { Hono } from 'hono';
import { requireSession } from '../lib/auth.js';
import type { Activity } from '../store/types.js';
import { store } from '../store/index.js';

type SpendCategoryKey = 'card' | 'agent' | 'transfers';

interface SpendBucket {
  key: SpendCategoryKey;
  label: string;
  totalUsd: number;
}

const CATEGORY_BY_KIND: Partial<Record<Activity['k'], { key: SpendCategoryKey; label: string }>> = {
  card: { key: 'card', label: 'Card' },
  amazon: { key: 'card', label: 'Card' },
  spotify: { key: 'card', label: 'Card' },
  uber: { key: 'card', label: 'Card' },
  agent: { key: 'agent', label: 'Agent' },
  x402: { key: 'agent', label: 'Agent' },
  out: { key: 'transfers', label: 'Transfers' },
};

export const spendRoutes = new Hono();

spendRoutes.use('*', requireSession);

spendRoutes.get('/monthly', async (c) => {
  const u = c.get('user');
  // Scale wave 3 — the category rollup walks the full activity aggregate.
  const full = await store.user(u.id);
  const month = currentUtcMonth();
  const buckets = new Map<SpendCategoryKey, SpendBucket>();

  for (const row of full.activity) {
    if (!row.at.startsWith(month) || row.pos) continue;
    if (isSeededDemoSpend(row)) continue;
    const category = CATEGORY_BY_KIND[row.k];
    if (!category) continue;
    const amountUsd = activityAmountUsd(row.a);
    if (amountUsd <= 0) continue;
    const existing = buckets.get(category.key) ?? { ...category, totalUsd: 0 };
    existing.totalUsd = roundCents(existing.totalUsd + amountUsd);
    buckets.set(category.key, existing);
  }

  const categories = Array.from(buckets.values()).sort((a, b) => b.totalUsd - a.totalUsd);
  const totalUsd = roundCents(categories.reduce((sum, bucket) => sum + bucket.totalUsd, 0));
  return c.json({ ok: true, month, totalUsd, categories });
});

function isSeededDemoSpend(row: Activity): boolean {
  const subtitle = row.s.replace(/\u00b7/g, '|');
  return row.k === 'x402' && row.n === 'api.exa.ai' && subtitle === 'AGENT | POLICY OK' && activityAmountUsd(row.a) === 0.12;
}

function currentUtcMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function activityAmountUsd(amount: string): number {
  const normalized = amount.replace(/\u2212/g, '-').replace(/,/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const value = Math.abs(Number(match[0]));
  return Number.isFinite(value) ? roundCents(value) : 0;
}

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
