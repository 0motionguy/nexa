import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cards mini app wiring', () => {
  it('surfaces Collector Crypt cards in the Trade screen', () => {
    const html = readFileSync(resolve(process.cwd(), 'app.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const api = readFileSync(resolve(process.cwd(), 'src/lib/api.ts'), 'utf8');

    expect(html).toContain('data-trade-venue="cards"');
    expect(html).toContain('id="s33"');
    expect(html).toContain('data-cards-back="s26"');
    expect(html).toContain('id="cardsMarketsList"');
    expect(html).toContain('id="cardsDetailBuy"');
    expect(api).toContain("cards: {");
    expect(api).toContain("list: (opts?: CardsListOptions)");
    expect(api).toContain("buy: (body: CardsBuyInput, opts?: { idempotencyKey?: string })");
    expect(api).toContain("'Idempotency-Key': opts.idempotencyKey");
    expect(app).toContain('async function fetchCardsMarkets()');
    expect(app).toContain('renderCardsMarkets');
    expect(app).toContain('function renderCardsScreen()');
    expect(app).toContain('async function selectCollectorCard(');
    expect(app).toContain('cardsBuyAttempt = idempotencyKeyFor(cardsBuyAttempt, fingerprint)');
    expect(app).toContain('.buy(buyBody, { idempotencyKey: cardsBuyAttempt.idempotencyKey })');
  });
});
