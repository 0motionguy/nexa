/**
 * Sprint 10 Phase 2 ε — standalone scheduler entrypoint.
 *
 * W2-B hardening: the no-redis path is now environment-aware — dev/test/demo
 * exits 0 (compose `restart: on-failure` won't loop on a clean exit; the
 * admin sweep endpoints stay as the manual fallback), real production exits 1
 * (fail-closed: a scheduler without Redis silently drops every scheduled
 * job), and a set-but-unparseable REDIS_URL exits 1 in every environment.
 * The worker boot path is covered by the worker modules' own specs
 * (claim-sweeper.spec, subscription-renewer.spec).
 *
 * We intercept `process.exit` to capture exit codes without tearing down the
 * vitest worker. fills-notifier is module-mocked so the gauge test can prove
 * updateQueueDepthGauges samples that queue (W2-B added it — the worker was
 * started but its queue was missing from the gauge).
 */

import { describe, expect, it, vi } from 'vitest';
import { runScheduler, updateQueueDepthGauges } from './scheduler.js';
import { env, features } from '../lib/env.js';
import { bullmqQueueDepth } from '../lib/metrics.js';

vi.mock('./fills-notifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fills-notifier.js')>();
  return {
    ...actual,
    fillsNotifierQueue: {
      getJobCounts: async () => ({ waiting: 3, active: 1 }),
    } as unknown as typeof actual.fillsNotifierQueue,
  };
});

// env/features are intentionally mutable for tests — see the comment on
// runtimeFailClosed() in lib/env.ts and the same idiom in auth-ticket.spec.ts.
const envMut = env as unknown as {
  NODE_ENV: 'development' | 'test' | 'production';
  DEMO_MODE: boolean;
  REDIS_URL: string | undefined;
};
const featuresMut = features as unknown as { redis: boolean };

/**
 * Spy on process.exit, capturing the code and throwing to short-circuit
 * runScheduler (which would otherwise carry on past the exit).
 */
function interceptExit(): { spy: ReturnType<typeof vi.spyOn>; code: () => number | null } {
  let captured: number | null = null;
  const spy = vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: number | string | null | undefined) => {
      captured = typeof code === 'number' ? code : 0;
      throw new Error('test:process_exit');
    });
  return { spy, code: () => captured };
}

describe('runScheduler — exit codes', () => {
  it('exits 0 in dev/test when redis is unavailable', async () => {
    expect(features.redis).toBe(false);

    const exit = interceptExit();
    try {
      await runScheduler();
    } catch (e) {
      // Expected — our mock throws to halt the flow.
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe('test:process_exit');
    }

    expect(exit.spy).toHaveBeenCalledOnce();
    expect(exit.code()).toBe(0);
    exit.spy.mockRestore();
  });

  it('exits 1 in real production when redis is unavailable (fail-closed)', async () => {
    const prev = { nodeEnv: envMut.NODE_ENV, demo: envMut.DEMO_MODE };
    envMut.NODE_ENV = 'production';
    envMut.DEMO_MODE = false;

    const exit = interceptExit();
    try {
      await runScheduler();
    } catch (e) {
      expect((e as Error).message).toBe('test:process_exit');
    } finally {
      envMut.NODE_ENV = prev.nodeEnv;
      envMut.DEMO_MODE = prev.demo;
    }

    expect(exit.spy).toHaveBeenCalledOnce();
    expect(exit.code()).toBe(1);
    exit.spy.mockRestore();
  });

  it('exits 1 in every environment when REDIS_URL is set but unparseable', async () => {
    const prev = { url: envMut.REDIS_URL, redis: featuresMut.redis };
    envMut.REDIS_URL = 'not-a-url';
    featuresMut.redis = true;

    const exit = interceptExit();
    try {
      await runScheduler();
    } catch (e) {
      expect((e as Error).message).toBe('test:process_exit');
    } finally {
      envMut.REDIS_URL = prev.url;
      featuresMut.redis = prev.redis;
    }

    expect(exit.spy).toHaveBeenCalledOnce();
    expect(exit.code()).toBe(1);
    exit.spy.mockRestore();
  });
});

describe('updateQueueDepthGauges', () => {
  it('samples the fills-notifier queue (W2-B: was missing from the gauge)', async () => {
    await updateQueueDepthGauges();

    const metric = await bullmqQueueDepth.get();
    const fills = metric.values.filter((v) => v.labels['queue'] === 'fills-notifier');
    const byState = Object.fromEntries(fills.map((v) => [v.labels['state'], v.value]));

    expect(byState['waiting']).toBe(3);
    expect(byState['active']).toBe(1);
  });
});
