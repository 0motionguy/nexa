# Logos & Asset Fallbacks — sources, chain, and the probe

**Written 2026-07-02 (Wave 3).** Every market row renders an image or a
deterministic letter tile. Broken-after-fallback is 0 by construction: every
render site attaches an `onerror` handler that swaps the failed image for the
letter tile with no layout shift (thumb containers are fixed-size).

## Canonical render sites

| Surface | Element/helper | Source |
|---|---|---|
| Perps + HL Spot + Stocks-perps rows | `<nexa-market-row logo-url>` (own onerror fallback) | `marketLogoUrl()` in `app-main.ts` |
| Memes + xStocks rows | `marketThumbEl()` (44px, onerror → `fallbackLetter`) | Jupiter `imageUrl` / Backed `icon` |
| Cards rows | `marketThumbEl()` (unified in Wave 3 — was a hand-rolled img without onerror) | Collector Crypt `imageUrl` |
| Cards detail hero | `#cardsDetailImg` + `#cardsDetailFallback` pair | same |
| Predictions event art | `.pm-event-img` (onerror → title letter, added Wave 3) | Polymarket S3 `imageUrl` |
| Swap sheets | `setOrderLogo()` | token logo passed from the row |

New one-off `<img>` tags for market assets are a review smell — use
`marketThumbEl` or the row component.

## URL resolution (`marketLogoUrl`)

1. Explicit `logoUrl`/`imageUrl` from the API wins.
2. `hyperliquid` / `hyperliquid-spot` → **HyperLiquid's own CDN**
   `https://app.hyperliquid.xyz/coins/<COIN>.svg` — serves every listed coin
   including natives (BTC/ETH/HYPE/PURR probed 200). The old TradingView
   crypto CDN 404'd on the long tail and every stock ticker.
3. `hyperliquid-hip3` (stock perps, `xyz:TSLA`) → Backed xStocks `icon`
   looked up by bare ticker from the xStocks cache; index aliases
   `SP500→SPY`, `XYZ100→QQQ`. No real-world equivalent (e.g. SKHX) → letter.
4. Otherwise TradingView crypto CDN, then letter.

## The probe

```
node scripts/probe-market-logos.mjs [--base http://localhost:8090] [--strict]
```

Pulls 50 perps / 50 spot / 100 memes / 50 predictions / 50 xStocks /
50 stock-perps / 50 cards from a running API, resolves each logo the way the
UI does, and HEAD-checks the URLs. Latest run (2026-07-02):

```
surface        total  real  fallback  broken
perps            50    50         0       0
hl-spot          50    50         0       0
memes           100    98         0       2   (rotted nftstorage.link gateways)
predictions      50    50         0       0
xstocks          50    50         0       0
stocks-perps     50    25        25       0   (trade.xyz synthetics → letters)
cards            50    49         0       1   (dead arweave.net asset)
```

347/350 real art; the 3 dead upstream URLs degrade to letter tiles at
runtime (that failure mode is exactly what the Wave-3 onerror unification
fixed — they used to render blank squares). Exit is 0 with a WARN unless
`--strict`, which is the CI-hardening mode once upstream metadata rot is
worth failing a build over.
