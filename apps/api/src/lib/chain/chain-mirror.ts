/**
 * Chain mirror — Sprint 12 Phase 0.
 *
 * The Store's earn ledger (earnDeposit / earnWithdraw / autoDivestIfNeeded /
 * topUp's earn-by-default tail) used to mutate balUsd/earnUsd ONLY — no chain
 * call. That meant `User.preferredVaultTier` had no effect on auto-flows: only
 * the explicit /earn/{deposit,withdraw} routes routed through EarnRouter.
 *
 * This module wires the missing chain side. The Store accepts a ChainMirror via
 * `attachChainMirror(m)` at boot; after a successful ledger write, the Store
 * fires `mirror.depositEarn(...)` / `withdrawEarn(...)` as fire-and-forget.
 *
 * BEST-EFFORT contract:
 *   - The mirror MUST swallow chain errors (network blips, demo-mode no-ops,
 *     RPC rate limits). A chain failure must NOT roll back the ledger move
 *     that already succeeded.
 *   - Callers (the Store) MUST NOT await the mirror result — they `void` it
 *     so a slow RPC doesn't block the request return.
 *   - The mirror is OPTIONAL on the Store. Test setups that never call
 *     `attachChainMirror` see no chain traffic at all.
 *
 * Type-only imports here keep this file free of runtime circular-dep risk:
 *   chain-mirror.ts → store/types.js (types only)
 *   chain-mirror.ts → narrow earn-router shape
 *   chain-mirror.ts → store/types.js (types only)
 */

import type { ChainMirror, SessionUser, Store, User, VaultTier } from '../../store/types.js';
import { log } from '../log.js';
import { chainMirrorFailures } from '../metrics.js';

interface ChainMirrorStack {
  earnRouter: {
    deposit(
      u: SessionUser,
      amountUsd: number,
      tier: VaultTier | undefined,
      setPreferredVaultTier: (u: SessionUser, tier: VaultTier) => Promise<User>,
    ): Promise<unknown>;
    withdraw(u: SessionUser, amountUsd: number, tier: VaultTier | undefined): Promise<unknown>;
  };
}

/**
 * Build a ChainMirror that delegates to `stack.earnRouter`. All adapter errors
 * are caught and logged at warn — the ledger row remains the source of truth.
 *
 * The deposit setter signature matches EarnRouter.deposit's `setPreferredVaultTier`
 * callback (User, VaultTier) → User; we thread the Store's own setter through so
 * the router can persist a tier change initiated by a flow that supplied `tier`.
 * The mirror itself never originates a tier — callers pass the user's current
 * `preferredVaultTier` and so the setter is a no-op in this code path. It's
 * still wired through so the EarnRouter contract is honored.
 */
export function buildChainMirror(stack: ChainMirrorStack, store: Store): ChainMirror {
  return {
    async depositEarn(u, amountUsd, tier) {
      try {
        await stack.earnRouter.deposit(u, amountUsd, tier, (user, t) =>
          store.setPreferredVaultTier(user, t),
        );
      } catch (e) {
        // Sprint 13 COMMIT 7 (C9) — bump the Prom counter so the alerts.yml
        // rate-on-rate rule fires when the chain side goes silent.
        chainMirrorFailures.inc({ op: 'deposit', tier: tier ?? 'unset' });
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId: u.id, amountUsd, tier },
          'chain-mirror: depositEarn failed (ledger move kept)',
        );
      }
    },
    async withdrawEarn(u, amountUsd, tier) {
      try {
        await stack.earnRouter.withdraw(u, amountUsd, tier);
      } catch (e) {
        chainMirrorFailures.inc({ op: 'withdraw', tier: tier ?? 'unset' });
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId: u.id, amountUsd, tier },
          'chain-mirror: withdrawEarn failed (ledger move kept)',
        );
      }
    },
  };
}
