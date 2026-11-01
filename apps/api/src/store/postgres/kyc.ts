/**
 * PgKyc — KYC status updates on nb_users.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nbUsers } from '../../db/schema/index.js';
import type { KycStatus, SessionUser } from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';

export class PgKyc {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
  ) {}

  async setKyc(u: SessionUser, status: KycStatus): Promise<void> {
    await this.db.update(nbUsers).set({ kycStatus: status }).where(eq(nbUsers.id, u.id));
    u.kycStatus = status;
    await this.core.invalidateUser(u.id);
  }
}
