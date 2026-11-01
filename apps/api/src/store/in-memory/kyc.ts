/**
 * InMemoryKyc — KYC status update on the live user object.
 *
 * Scale wave 3 — sessions now pass detached SessionUser projections, so the
 * module resolves the canonical map record before writing; mutating only the
 * snapshot would drop the status on the floor for every later hydrate.
 */

import type { KycStatus, SessionUser } from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';

export class InMemoryKyc {
  constructor(private state: InMemoryState) {}

  async setKyc(u: SessionUser, status: KycStatus): Promise<void> {
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    live.kycStatus = status;
    u.kycStatus = status;
  }
}
