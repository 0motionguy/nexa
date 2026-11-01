/**
 * Chain stack — one factory exposes all on-chain adapters.
 *
 * Routes call `getChainStack()` and don't care whether they're talking to
 * Chainstack Base mainnet RPC or a demo mock — the per-adapter `isLive`
 * getter does the gating.
 */

import { x402Settler } from './x402.js';
import { aaveAdapter } from './defi.js';
import { yoUsdAdapter } from './yousd.js';
import { compoundAdapter } from './compound.js';
import { morphoAdapter, morphoHighYieldAdapter } from './morpho.js';
import { lifiAdapter, lifiBridgeAdapter } from './lifi.js';
import { socketAdapter } from './socket.js';
import { gnosisPayAdapter } from './gnosisPay.js';
import { spongeAdapter } from './sponge.js';
import { walletService } from './wallet.js';
import { executor } from './alchemy.js';
import { EarnRouter } from '../earn-router.js';
import { BridgeRouter } from '../bridge-router.js';

export interface ChainStack {
  x402: typeof x402Settler;
  aave: typeof aaveAdapter;
  yousd: typeof yoUsdAdapter;
  compound: typeof compoundAdapter;
  morpho: typeof morphoAdapter;
  morphoHighYield: typeof morphoHighYieldAdapter;
  lifi: typeof lifiAdapter;
  socket: typeof socketAdapter;
  gnosis: typeof gnosisPayAdapter;
  sponge: typeof spongeAdapter;
  wallets: typeof walletService;
  executor: typeof executor;
  /** Phase 1 — picks the right adapter per user-tier preference. */
  earnRouter: EarnRouter;
  /** Phase 2 — Socket primary, LIFI fallback bridge router. */
  bridgeRouter: BridgeRouter;
}

/**
 * Singleton EarnRouter. Initialized lazily so any test that swaps adapters in
 * the stack composition before first `getChainStack()` call still sees the
 * swap. After first init the same router instance is reused.
 */
let _earnRouter: EarnRouter | null = null;
function buildEarnRouter(): EarnRouter {
  if (!_earnRouter) {
    _earnRouter = new EarnRouter({
      yousd: yoUsdAdapter,
      aave: aaveAdapter,
      compound: compoundAdapter,
      morpho: morphoAdapter,
      morphoHighYield: morphoHighYieldAdapter,
    });
  }
  return _earnRouter;
}

/** Same lazy-init pattern as the earn router. */
let _bridgeRouter: BridgeRouter | null = null;
function buildBridgeRouter(): BridgeRouter {
  if (!_bridgeRouter) {
    _bridgeRouter = new BridgeRouter(socketAdapter, lifiBridgeAdapter, executor);
  }
  return _bridgeRouter;
}

export function getChainStack(): ChainStack {
  return {
    x402: x402Settler,
    aave: aaveAdapter,
    yousd: yoUsdAdapter,
    compound: compoundAdapter,
    morpho: morphoAdapter,
    morphoHighYield: morphoHighYieldAdapter,
    lifi: lifiAdapter,
    socket: socketAdapter,
    gnosis: gnosisPayAdapter,
    sponge: spongeAdapter,
    wallets: walletService,
    executor,
    earnRouter: buildEarnRouter(),
    bridgeRouter: buildBridgeRouter(),
  };
}

export { ChainError } from './units.js';
