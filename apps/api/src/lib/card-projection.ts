import { env } from './env.js';
import { getChainStack } from './chain/index.js';

export interface CardProjection {
  frozen: boolean;
  dayLimitUsd: number;
  last4: string | null;
  network: string | null;
  safeAddress: string | null;
  demo: boolean;
  card: {
    last4: string;
    network: string;
    kind: 'DEBIT';
    frozen: boolean;
    dayLimitUsd: number;
    demo: boolean;
  } | null;
}

export async function resolveCardProjection(
  userId: string,
  frozen: boolean,
  dayLimitUsd: number,
): Promise<CardProjection> {
  let last4: string | null = null;
  let network: string | null = null;
  let safeAddress: string | null = null;
  let demo = false;

  try {
    const card = await getChainStack().gnosis.getCard(userId);
    if (!card.demo || env.DEMO_MODE) {
      last4 = card.last4;
      network = card.network;
      safeAddress = card.safeAddress;
      demo = card.demo;
    }
  } catch {
    // Leave card identity unavailable rather than inventing a replacement.
  }

  return {
    frozen,
    dayLimitUsd,
    last4,
    network,
    safeAddress,
    demo,
    card:
      last4 && network
        ? {
            last4,
            network,
            kind: 'DEBIT',
            frozen,
            dayLimitUsd,
            demo,
          }
        : null,
  };
}
