# MAZE — Product Context

> Brand renamed NEXA → MAZE on 2026-06-13. See [`HANDOVER.md`](./HANDOVER.md) §7 and `~/.claude/projects/d--dev-Neo-Bank/memory/maze-rebrand.md` for the full mapping.

## What it is

A crypto-rails neobank for **humans and AI agents on one ledger**. Humans get a
global dollar account (US ACH + EU IBAN), a Visa-style card, auto-earning
balance (8.4% est.), payment links and clip-campaign payouts. Agents get
**budgeted wallets under server-enforced policy** (per-tx/daily caps, endpoint
allowlists, kill switch) that pay x402 endpoints; vendors monetize their APIs
through the x402 portal. Claude connects over MCP.

## Register

**Product** (app UI: design serves the product). Three surfaces:
- `app.html` — the 24-screen product app (phone-column layout, max 520px)
- `landing.html` — marketing page (brand register, design IS the product there)
- `portal.html` — x402 vendor portal (product register)

## Audience

Mirko (founder) demoing to partners/investors; later freelancers/creators
getting paid globally, and developers wiring agents. Used on phones and
desktop browsers, mostly indoors, mixed lighting. Calm fintech confidence,
not crypto-casino energy.

## Design system (the contract — do not drift)

Source of truth: `../app-v2.html` + `../nexa_agentic_ascii_neobank_design_system.md`
in the parent folder. Tokens live in `apps/web/src/tokens.css` (+ semantic
aliases). **Light-first** `#F5F6FA` bg, white surfaces, near-black ink
`#090A0C`, single orange accent `#FF6A1A` (≤10% of surface — restrained
strategy), state colors (success `#18A957`, warn `#F5A524`, danger `#E5484D`).
**Dark theme** is fully polished (2026-06-13 pass) via `.stage[data-theme="dark"]`
rebinding; new dark-only tokens `--accent-edge` (0.55 alpha) and `--surface-2`
(`#1c1c21`) carry the elevated-surface and tiny-accent-line affordances. The
`.stage` rule MUST set `color: var(--fg)` so dark text inherits the scoped
token; without it the body color is locked to light mode (a regression to watch
for).

Type: **IBM Plex Mono** (display/labels/numbers, tabular) + **Inter** (body).
Radii 10/14/22/999. Soft layered shadows. ASCII dot-globe is the brand motif
(canvas engine `src/lib/globe.ts`), now with live transaction flares between
city anchors + rotating city/user marker pills (5 cities + 5 users). The
square-M emblem (orange square, 3-bar M cutout) is the new MAZE mark, rendered
as inline `<symbol id="m-emblem">` and used as favicon + on-card badge.

Motion: **plays by default** (design contract; `?motion=off` opts out).
Screen slide-in 320ms, staggered body fade-ups, count-ups, sheet slide-ups,
globe drift, arc spawn intervals (260ms home, 1100ms landing centerpiece).
Ease: `cubic-bezier(.2,.65,.25,1)`.

Microcopy: bank-grade calm ("Payment required", "Settlement complete");
never crypto-bro ("ape", "moon", "supercharged"). Zero chain vocabulary
outside collapsed "Advanced" drawers.

## Taste-skill bans (enforced 2026-06-13)

- **Em-dashes (`—`)** banned in user-visible copy. Use `·` for separators in
  eyebrows / labels, period or comma for prose breaks, `…` for placeholder
  values. Source-file comments are exempt.
- **Section-number eyebrows** ("01 · The Global Layer") banned on landing.
  Eyebrows name the topic in plain language; no numeric prefixes.
- **Top-stripe `::before` gradient accents** banned. Use functional accent
  affordances instead: focus rings, hairlines on the top edge of dark-mode
  cards, active-tab rims, live-tag pulse halos. The orange/green stripe on
  cards is "exactly the AI slope" the user explicitly rejected.
- **Logo wall = logos only.** No industry/category labels under wordmarks.

## Quality bar

Flagship demo. Pixel-fidelity to the v2 prototype wins ties; deliberate
improvements (hover affordances, a11y, centering fixes, dark-mode definition
via `--accent-edge` hairlines, rotating globe markers, live arc flares) are
welcome when they don't change the design language.

## Canonical Mirko fixtures

- Balance: **$4,820.40**
- Earning position: **$3,200.00**
- Agent weekly budget: **$50.00**
- Agent spent: **$13.20**
- Spending this month: **$1,692.45** (+12% vs last month)
- Top-3 recent transactions: Salary · Acme Studio (+$2,400.00), api.exa.ai (−$0.12), Blue Bottle Coffee (−$6.40)

Lives in `apps/web/app.html` (static initial paint) AND `apps/web/src/app-main.ts`
(`L = { bal: 4820.4, earnPos: 3200, spentAg: 13.2, capAg: 50 }`). Keep both in
sync. The server ledger in `apps/api/src/store/ledger.ts` mirrors the same
seed numbers so LIVE mode shows familiar data.
