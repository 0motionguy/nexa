/**
 * Health summarizer for `GET /v1/feeds/health`. Aggregates each registered
 * adapter's `healthSnapshot()` plus hub-level counts.
 *
 * Shape is stable + small — clients (`useFeedHealth` hook) and synthetic
 * monitoring (Blackbox Exporter) consume it.
 */

import type { Hub } from './hub.js';
import type { VenueHealth, VenueTag } from './types.js';

export interface FeedsHealthResponse {
  /** Hub-level overall flag — true when no venue is in `open` breaker state. */
  readonly ok: boolean;
  readonly hub: {
    readonly clients: number;
    readonly subscriptions: number;
    readonly activeTopics: number;
  };
  readonly venues: Record<VenueTag, VenueHealth>;
}

export function summarizeHealth(hub: Hub, clientCount: number): FeedsHealthResponse {
  const venues = {} as Record<VenueTag, VenueHealth>;
  let allOk = true;
  for (const adapter of hub.listAdapters()) {
    const snap = adapter.healthSnapshot();
    venues[adapter.venue] = snap;
    if (snap.breakerState === 'open') allOk = false;
  }
  return {
    ok: allOk,
    hub: {
      clients: clientCount,
      subscriptions: hub.totalSubscriptions(),
      activeTopics: hub.activeTopicCount(),
    },
    venues,
  };
}
