/**
 * Sprint 10 Phase 2 ε — shared BullMQ connection helper.
 *
 * The helper is pure: env in, ConnectionOptions or null out. Verifies the
 * null-on-no-redis path (the dominant case under vitest, where REDIS_URL is
 * unset by default) so callers know they get a clean null rather than a
 * thrown error.
 */

import { describe, expect, it } from 'vitest';
import { makeConnectionOpts } from './connection.js';
import { features } from '../lib/env.js';

describe('makeConnectionOpts', () => {
  it('returns null when redis is not configured (vitest default)', () => {
    // The vitest env runs with REDIS_URL unset, so the gate's `!features.redis`
    // branch fires. Pin the precondition so a future feature flag change is
    // visible.
    expect(features.redis).toBe(false);
    expect(makeConnectionOpts()).toBeNull();
  });
});
