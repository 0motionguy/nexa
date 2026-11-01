/**
 * PgCards — card freeze + day-limit state.
 *
 * Both methods are simple upserts on nb_card_state followed by a user-cache
 * invalidate so the next hydrateUser returns fresh values.
 */

import type { Db } from '../../db/client.js';
import { nbCardState } from '../../db/schema/index.js';
import type { SessionUser } from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';

export class PgCards {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
  ) {}

  async setCardFrozen(u: SessionUser, frozen: boolean): Promise<void> {
    await this.db
      .insert(nbCardState)
      .values({ userId: u.id, frozen, dayLimitUsd: u.cardDayLimitUsd })
      .onConflictDoUpdate({
        target: nbCardState.userId,
        set: { frozen, updatedAt: new Date() },
      });
    u.cardFrozen = frozen;
    await this.core.invalidateUser(u.id);
  }

  async setCardDayLimit(u: SessionUser, limit: number): Promise<void> {
    await this.db
      .insert(nbCardState)
      .values({ userId: u.id, frozen: u.cardFrozen, dayLimitUsd: limit })
      .onConflictDoUpdate({
        target: nbCardState.userId,
        set: { dayLimitUsd: limit, updatedAt: new Date() },
      });
    u.cardDayLimitUsd = limit;
    await this.core.invalidateUser(u.id);
  }
}
