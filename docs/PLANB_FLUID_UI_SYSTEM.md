# PLANB Fluid UI System — apps/web (MAZE PWA)

> Sprint contract for the "ultra-fluid" interaction pass, 2026-07-03. Inspect-first
> result: **zero new runtime dependencies**. The platform already has the primitives;
> this sprint makes them fast, honest, and viewport-native. NOT a rebuild.

Plan of record for waves/PRs: this doc. Companion audits: `docs/TOP_LEVEL_APP_READINESS.md`
(surface gates), `docs/MARKETS_PROVIDER_GATES.md` (blocked-CTA truth),
`docs/HANDOVER-2026-07-03-COMPETITOR-SPRINT.md` (session traps honored by this sprint).

"PLANB" is the initiative codename only. It does not (and should not) appear in product code.

## 1. What "fluid" means here (acceptance criteria)

1. Market lists expand to hundreds of rows without jank. "Show all" (175+ rows) must not
   rebuild the world: rows build their shadow DOM once, updates patch in place,
   offscreen rows skip layout/paint.
2. Every market list loads with skeleton rows in the exact geometry they replace
   (70px `nexa-market-row`, 52px `.lrow`, pm-card height). Empty ≠ loading ≠ error.
3. No polling storms. Background tabs go network-quiet. SSE is primary for ledger
   freshness; intervals are the fallback, not the engine.
4. No phone frame. `.stage` is fluid: mobile-first full-bleed, measured widening on
   desktop, Trade surfaces earn extra width. Still a single-column app, not a
   desktop workspace.
5. Screen changes glide: same-document View Transitions where supported, current CSS
   everywhere else, static under `html.rm`. Only `transform`/`opacity` animate.
6. Identity without logos: deterministic dot-matrix marks (seeded identicons) replace
   the bare letter/hue fallback. Semantic identity, never decoration.
7. Blocked money CTAs always name the exact blocker (existing `venueTradeBlock()`
   grammar), on every venue CTA that has a gate.
8. Console shows zero red on a full tab walk. 72+ vitest and 168+ Playwright stay green.

## 2. Dependency decision table

| Package | Needed? | Why | Alternative chosen | Bundle risk |
|---|---|---|---|---|
| @tanstack/react-virtual | No | App is vanilla web components, not React; sibling NEO even rolled virtualization back (regression test pins it out) | `content-visibility: auto` + `contain-intrinsic-size` on fixed-height rows + build-once elements | none (0 KB) |
| @tanstack/virtual-core | No | Vanilla lifecycle wiring is rough upstream; fixed 52/70px rows need no measurement engine | same | none |
| Framer Motion / Motion One | No | MAZE motion contract (.15/.18/.22/.28s on `--ease`) already covers state motion | CSS + View Transitions API (Baseline; guarded) | none |
| vaul / cupertino-pane | No | Draggable sheets + shared review sheet already exist and are e2e-covered (`e2e/review-sheet.spec.ts`); vaul is React-only and ~2 years stale | keep `.ovl`/`.sheet` system | none |
| TanStack Query | No | `lib/api.ts` wrapper + hydrate TTLs exist; the defect is poll discipline, not cache absence | SSE-aware cadence + `document.hidden` gating | none |
| Jotai / Zustand | No | Hot path already patches `textContent` per row (`updatePrice`); module state is fine in vanilla | keep as-is | none |
| lightweight-charts | already in use | CDN-lazy on s27d only; `@nexa/charts` is owned by a parallel session and unconsumed here | keep as-is this sprint | unchanged |

Net new runtime deps: **zero**.

## 3. Component inventory (verified 2026-07-03)

### Exists, reuse (do not rebuild)
| Capability | Where |
|---|---|
| Shared money review sheet | `openReviewSheet()` `app-main.ts:2004`, confirm delegate `:2060`, spec `e2e/review-sheet.spec.ts` |
| Draggable bottom sheets | `.ovl`/`.sheet` + pointer drag `app-main.ts:1919-1966`, `shup` keyframes `app.css:242` |
| Visible-row realtime subs | IntersectionObserver rootMargin 120px + `HL_HUB_SUB_CAP=40`, `app-main.ts:4537-4585` |
| Ref-counted hub binding | `createRealtimeHubBinding()` `app-main.ts:4376-4497` over `@nexa/realtime-client` (sub/unsub on live socket) |
| Screen/tab transitions | `scrIn` + `fadeUp2` `app.css:39,261`, sheet `.28s`, top-loadbar |
| Reduced motion gate | `html.rm` (`?motion=off` or OS pref), all keyframes under `html:not(.rm)` `base.css:95-104` |
| Skeleton primitive | `.skel` shimmer `app.css:166` (used on home balance + chart placeholder only, pre-sprint) |
| Blocked-CTA reasons | `venueTradeBlock()` `app-main.ts:1529` + `/me/profile` venue booleans + `/system/health.features` |
| Dot DNA | canvas dot-globe `lib/globe.ts`, `.vcard` 12px dot texture `app.css:206`, `.m-mark` `base.css:80` |
| Market row element | `components/nexa-market-row.ts` w/ `updatePrice()` fast path `:372` |

### Gaps this sprint closes
| Gap | Evidence | Wave |
|---|---|---|
| Row renders wipe shadow root + re-parse a per-instance `<style>` on every `setAttribute` (~16 rebuilds before first connect) | `nexa-market-row.ts:233-252` | W1 |
| List renders clear host + rebuild all rows; Show-all rebuilds 175+ | `app-main.ts:5313` (`host.textContent=''`), `:5264` | W1 |
| No skeletons on market lists (empty row only) | `app-main.ts:5325-5329`, `:7537` | W1 |
| Blanket 4s full-ledger poll alongside SSE, no hidden gating | `app-main.ts:1482-1487`, `:1491` | W2 |
| Jupiter/positions polls run in hidden tabs | `app-main.ts:4793`, `:6606` | W2 |
| `.stage` hard-capped 520px on desktop (phone frame) | `app.css:4-12` | W3 |
| No View Transitions in `go()` | `app-main.ts:1823` | W3 |
| Letter/hue-only logo fallback; no identity mark system | `nexa-market-row.ts:271-291`, `app-main.ts:5293` | W4 |
| Gate labels missing on non-trade-sheet CTAs (cards buy, jup swap entry) | sweep target | W4 |

## 4. Perf budgets and measurements

Baseline measured 2026-07-03 against prod (`https://nexa.aiso.tools/app.html#s27`,
main @ 6326147) with the scratchpad playwright-core probe: click `.market-show-all`
on `#hlMarketsList` (12 → 176 `nexa-market-row`s), `performance.now()` around the
click, PerformanceObserver longtask, mobile = 390px viewport at 4x CPU throttle.

After-numbers measured post-W1 (2026-07-03) with the same probe against the
LOCAL DEV stack (unminified vite modules — conservative vs the minified prod
baseline; W5 re-verifies on the deployed build).

| Metric | Baseline (measured) | Target | After W1 (measured) |
|---|---|---|---|
| Show-all to paint, desktop 1280 | **438 ms** (262 ms script) | < 120 ms | **40.5 ms** (14 ms script) — 10.8x |
| Show-all to paint, mobile 390 @ 4x CPU | **4,558 ms** (2,748 ms script) | < 250 ms | **281 ms** (104 ms script) — 16.2x |
| Longest task during expansion | 412 ms desktop · **4,400 ms mobile** | none > 100 ms | desktop **none** · mobile 227 ms (from 4,400) |
| Shadow-root builds per 176-row expansion | ~176 full builds + ~2,800 attr-change rebuilds (code-derived, old `nexa-market-row.ts:233-252`) | 176 one-time builds, 0 rebuilds | 176 one-time builds; attribute changes batch per microtask |
| Ledger requests/min, tab visible, SSE healthy | 15/min (4s interval, code-derived `app-main.ts:1486`) | ≤ 4/min + event-driven | ≤ 2 reads / 12s window (CI: `e2e/poll-quiet.spec.ts`) |
| Ledger requests/min, tab hidden | 15/min (no gating) | **0** (CI: `e2e/poll-quiet.spec.ts`) |
| Console errors on #s27 probe | 0 | 0 (full 5-screen walk in W5) | 0 (probe + e2e walk test) |
| New runtime deps | 0 | 0 | 0 |

CI contract for the list engine: `e2e/fluid-ui.spec.ts` — 200-row mocked
expansion < 500 ms + first-page row elements REUSED (identity-checked) +
skeletons visible during a delayed first hydrate + zero app console errors
on a five-screen walk. 46/46 green with `markets-and-perks`,
`session-charts-stocks-jup-pm`, `live-mode` on 2026-07-03.

CI bound (generous, flake-safe): mocked 200-row expansion < 500 ms in `e2e/fluid-ui.spec.ts`.

## 5. Motion contract (unchanged, enforced)

MAZE tokens only: `--ease: cubic-bezier(.2,.65,.25,1)`; durations .15/.18/.22/.28s; no new
curves, no bounce. View Transitions reuse the scrIn DNA (14px translate + fade) and are
skipped when `html.rm`, `document.hidden`, unsupported, or same-screen. `html.vt` disables
the CSS `scrIn` during a VT so nothing double-animates. Only `transform`/`opacity` animate;
`content-visibility` handles offscreen cost, not JS scroll listeners.

## 6. Wave map (each wave = one PR in the train)

| PR | Wave | Contents |
|---|---|---|
| #42 | W0 | this doc + measured baseline |
| #43 | W1 | build-once/batched `nexa-market-row` + `lib/list-reconcile.ts` (HL hosts) + `lib/list-skeleton.ts` + content-visibility CSS + spec-pin updates + `e2e/fluid-ui.spec.ts` + env-overridable e2e stack ports |
| #44 | W2 | SSE-aware ledger cadence (`onStatus` on the activity stream) + hidden gating for all pollers + visibilitychange restart |
| #45 | W3 | fluid `.stage` (560/640/880) + sheet/tabbar/toast caps + VT wrapper in `go()` + s27d desktop grid |
| #46 | W4 | `nexa-dot-mark` + market-row/thumb fallback adoption (CTA gate sweep verified already complete; empty-state adoption cut per contract) |
| W5 | W5 | `e2e/poll-quiet.spec.ts` + full-suite run + these after-numbers |

Execution rules: worktree off origin/main; never touch `packages/charts` or the main
checkout; exact-file staging; spec pins in `src/app-main.spec.ts` co-update in the same
commit that moves pinned source. Cut order if squeezed: s27d 2-col grid, dot-mark
shimmer/empty-state adoption, poll-quiet CI spec, CTA sweep breadth, stage width easing.
Never cut: the build-once/batched market row.
