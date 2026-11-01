/**
 * InMemoryCards — flip cardFrozen + cardDayLimitUsd on the live user object.
 */

import type { SessionUser } from '../types.js';

export class InMemoryCards {
  async setCardFrozen(u: SessionUser, frozen: boolean): Promise<void> {
    u.cardFrozen = frozen;
  }

  async setCardDayLimit(u: SessionUser, limit: number): Promise<void> {
    u.cardDayLimitUsd = limit;
  }
}
