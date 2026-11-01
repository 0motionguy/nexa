/**
 * React context for the realtime client.
 *
 * One `RealtimeClient` per provider — typically one per app. Hooks read
 * from the nearest provider, so test setups can mount a fresh client per
 * test by re-wrapping `<RealtimeProvider>`. The client itself is a
 * vanilla TS object that owns the SSE/WS transport + the store; React is
 * only used to fan its events into `useSyncExternalStore`-shaped selectors.
 *
 * Kept in a `.ts` file (not `.tsx`) since this module only constructs the
 * context — the `<RealtimeProvider>` JSX wrapper lives in `Provider.tsx`.
 */

import { createContext } from 'react';
import type { RealtimeClient } from '../RealtimeClient.js';

export const RealtimeContext = createContext<RealtimeClient | null>(null);
