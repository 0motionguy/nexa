import { describe, expect, it } from 'vitest';

import { RealtimeClient } from './RealtimeClient.js';
import { parse } from './topic.js';
import type { Topic } from './types.js';

describe('Neo realtime compatibility', () => {
  it('accepts HIP-3 symbols and parks without dropping subscription intent', () => {
    expect(parse('ticker:hl:xyz:SKHX')).toEqual({
      kind: 'ticker',
      venue: 'hl',
      symbol: 'xyz:SKHX',
    });

    const client = new RealtimeClient({ baseUrl: 'http://localhost', token: 'ticket' });
    client.acquire('ticker:hl:BTC' as Topic);
    client.suspend();

    expect(client.isSuspended()).toBe(true);
    expect(client.totalSubscriptions()).toBe(1);
    expect(typeof client.onFrame).toBe('function');
    client.close();
  });
});
