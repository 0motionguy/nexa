/**
 * React hooks surface smoke test — confirms the public exports from
 * `@nexa/realtime-client/react` resolve and the function shapes are right.
 * Doesn't render anything (no @testing-library/react in this workspace);
 * a behavior spec for the hooks lands in the consumer app where React's
 * test environment already exists.
 */

import { describe, expect, it } from 'vitest';
import * as ReactSurface from '../../../../packages/realtime-client/src/react/index.js';

describe('@nexa/realtime-client/react surface', () => {
  it('exports the provider component', () => {
    expect(typeof ReactSurface.RealtimeProvider).toBe('function');
  });

  it('exports every top-level hook', () => {
    expect(typeof ReactSurface.useTicker).toBe('function');
    expect(typeof ReactSurface.useStockPrice).toBe('function');
    expect(typeof ReactSurface.usePredictionPrice).toBe('function');
    expect(typeof ReactSurface.useCandle).toBe('function');
    expect(typeof ReactSurface.useOrderbook).toBe('function');
    expect(typeof ReactSurface.useTradeTick).toBe('function');
    expect(typeof ReactSurface.useTickerBatch).toBe('function');
    expect(typeof ReactSurface.useRealtimeClient).toBe('function');
  });
});
