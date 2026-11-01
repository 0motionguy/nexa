/**
 * `<RealtimeProvider>` — installs a `RealtimeClient` into the React tree.
 *
 * Owns the client's lifecycle: constructs on mount, tears down on
 * unmount. Token + baseUrl are reactive props — change either and the
 * provider rebuilds the transport (the orchestrator's debounce keeps a
 * mount/unmount cycle cheap).
 *
 * Most apps wrap this once near the root:
 *
 *   <RealtimeProvider baseUrl="https://nexa.aiso.tools" token={jwt}>
 *     <App />
 *   </RealtimeProvider>
 *
 * Hooks (`useTicker`, `useCandles`, etc.) read the client from context;
 * no manual subscribe-management is needed.
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { RealtimeClient, type RealtimeClientOptions } from '../RealtimeClient.js';
import { RealtimeContext } from './context.js';

export interface RealtimeProviderProps
  extends Omit<RealtimeClientOptions, 'baseUrl' | 'token'> {
  baseUrl: string;
  token: string;
  children: ReactNode;
}

export function RealtimeProvider(props: RealtimeProviderProps): ReactNode {
  const { baseUrl, token, children, mintTicket, ...rest } = props;

  // `rest` is intentionally NOT in the dep list: callbacks change identity
  // on every render in many app patterns, and reconstructing the client
  // would tear down every subscription. Callers wanting hot-swapped
  // callbacks should keep them stable with `useCallback`.
  const client = useMemo(
    () => new RealtimeClient({ baseUrl, token, ...(mintTicket ? { mintTicket } : {}), ...rest }),
    [baseUrl],
  );

  // Token rotation: don't rebuild the client; just rotate. The orchestrator
  // already knows how to swap the credential without dropping subscriptions.
  useEffect(() => {
    client.setToken(token);
    client.setMintTicket(mintTicket);
  }, [client, token, mintTicket]);

  // Tear down on unmount.
  useEffect(() => () => client.close(), [client]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}
