# MAZE — Design system

> Terminal-native fintech with provenance as the core aesthetic. Every
> number wears a quiet badge that says where it came from and how recent.

## Aesthetic direction

One sentence: **Apple-clean restraint + crypto-native mono + orange spark.**

The system is built to be quiet by default and to use a single saturated
color to mark the parts of the screen that are alive (a live market read, a
freshly-fetched APY, a placed order). Restraint is the brand; the orange is
the punctuation.

## Tokens

Single source of truth at [`apps/web/src/tokens.css`](apps/web/src/tokens.css)
and [`apps/web/src/tokens.semantic.css`](apps/web/src/tokens.semantic.css).
Two layers:

- **Primitive** — colors, type families, radii, motion. Touch only when the
  brand changes.
- **Semantic aliases** — agent states, x402 states, defi states, market
  states, spacing/type ramps. Cheap to add.

### The accent

`--accent: #FF6A1A` (orange) is the only saturated color in the system.
Three uses:
- `--accent-edge: rgba(255, 106, 26, .42)` for live-data halos
- `--accent-soft: rgba(255, 106, 26, .12)` for background tints
- `--accent` itself for the M-mark, primary CTAs, the live-pulse dot

Dark theme bumps `--accent-edge` to `.55` and `--accent-soft` to `.22` so
halos read against `#0A0A0C`.

### Surfaces

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F5F6FA` | `#0A0A0C` | App body, behind cards |
| `--surface` | `#FFFFFF` | `#121215` | Cards, sheets, pills |
| `--surface-2` | `#F8F9FB` | `#1c1c21` | Elevated cards (virtual card, etc.) |
| `--fg` | `#090A0C` | `#F4F5F8` | Body text |
| `--muted` | `#4F535C` | `rgba(244,245,248,.66)` | Secondary text |
| `--meta` | `#8A8D96` | `rgba(244,245,248,.42)` | Eyebrows, captions |

Dark theme is scoped to `.stage[data-theme="dark"]` so dark and light can
coexist on the same page (e.g. landing #built is a dark section on a light
page).

### Type ramp

| Token | Size | Use |
|---|---|---|
| `--fs-eyebrow` | 10px | Caps tracked .14em or .18em |
| `--fs-meta` | 11px | Mono captions, timestamps |
| `--fs-body-sm` | 12.5px | Card sub-lines, code endpoints |
| `--fs-body` | 13.5px | List row titles (`.lrow .t`) |
| `--fs-input` | 15px | Form inputs |
| `--fs-h3` | 17px | Card headings |
| `--fs-h2` | 26px | Section h2 (`.h-big`) |
| `--fs-balance` | 40px | Home screen balance |
| `--fs-amount-pad` | 52px | Send keypad display |

Two values dominate the large-number scale:
- `.bignum` = 32px mono — used for state-bar values, yield-ramp blended,
  drawer metric pop, agent budget, earn position
- `.balance` = 40px mono — used only on the home screen balance

When in doubt, pick `.bignum`. Don't invent a third scale.

### Radii

`--r-sm: 10px`, `--r-md: 14px`, `--r-lg: 22px`, `--pill: 999px`. Only these
four. Sheets at 22px, cards at 22px (`.card`), buttons at 999px.

### Shadows

`--sh-soft`, `--sh-card`, `--sh-phone`. No ad-hoc `rgba(0,0,0,...)` shadows.

### Spacing

`--sp-1` through `--sp-8` (4 / 8 / 12 / 16 / 20 / 24 / 32). **No
5/7/9/13/17.** If you find yourself reaching for a non-grid value, the
proportion is wrong.

## The Provenance design pattern

The unique-in-fintech part. Every financial value the user sees has a
source. The pattern is a four-tier composition:

1. **Atom** — `<nexa-source-badge>` ([components/nexa-source-badge.ts](apps/web/src/components/nexa-source-badge.ts))
   — `Live · Morpho · 12s ago · Docs↗`
2. **Molecule** — `<nexa-provider-card>` — name + category chip + status
   pill + summary + freshness + docs link. Used in s28 grid, landing
   `#built`, developers ecosystem section.
3. **Organism** — `<nexa-provenance-drawer>` — slide-up sheet that opens
   when any badge or card is tapped. Renders the full provider story.
4. **Page** — s28 transparency hub. State bar (`18 · 4 · 6`) + filter
   pills + provider grid + tabbed detail.

### Five custom elements

| Element | File | Lazy? |
|---|---|---|
| `<nexa-source-badge>` | `apps/web/src/components/nexa-source-badge.ts` | Eager |
| `<nexa-state-bar>` | `apps/web/src/components/nexa-state-bar.ts` | Eager |
| `<nexa-yield-ramp>` | `apps/web/src/components/nexa-yield-ramp.ts` | Eager |
| `<nexa-market-row>` | `apps/web/src/components/nexa-market-row.ts` | Eager |
| `<nexa-provider-card>` | `apps/web/src/components/nexa-provider-card.ts` | Eager |
| `<nexa-provenance-drawer>` | `apps/web/src/components/nexa-provenance-drawer.ts` | **Lazy** |

The drawer is dynamic-imported the first time anything opens it (saves
~13KB on first paint). All other components are statically imported.

## Motion contract

- Default ease: `cubic-bezier(.2, .65, .25, 1)` (exposed as `--ease`)
- Durations: `.15s` (micro), `.18s` (state changes), `.22s` (scrim),
  `.28s` (sheet slide). No `.20s` / `.25s` drift.
- Reduced-motion gate at the document level: `html.rm` is set by an inline
  script when `?motion=off` OR `prefers-reduced-motion: reduce`. All
  `@keyframes` live under `html:not(.rm)` blocks.
- Component-level reduced-motion fallbacks: every animation has a
  `@media (prefers-reduced-motion: reduce)` opt-out. Component-level
  `setInterval` updates (badge, provider-card) refresh only changed text
  nodes — never re-render the whole shadow tree.

## A11y baseline

- Every interactive `>= 44×44` on mobile (touch target). Drawer close is
  40×40 — accept on mobile because it sits in a 78vh sheet with no other
  touch competitors.
- Body text contrast `>= 4.5:1`. Large text (`>= 18px` or bold `>= 14px`)
  `>= 3:1`. Placeholder text also 4.5:1, not muted gray.
- Every overlay focus-traps on Tab (drawer cycles inside its sheet).
- `Escape` closes any open `.ovl.on` — wired globally in `app-main.ts`.
- Tabs follow the WAI ARIA APG pattern: `aria-controls` + `aria-selected`
  + Left/Right arrow nav + Home/End. Filter buttons use `aria-pressed`,
  NOT `role=tab` (they don't control panels).
- Error toasts: `role=alert` + `aria-live=assertive`. Success: `role=status`
  + `aria-live=polite`. Queue capped at 5.

## Brand rules (absolute)

- **No em-dashes** in user-visible copy. Use commas, colons, periods,
  middle dots, or parentheses.
- **No section eyebrows on every section.** One named kicker on one
  section is voice; eyebrows on every section is AI grammar.
- **No "01/02/03" eyebrows by default.** Numbered scaffolding only where
  the section IS a sequence (How it works steps).
- **No gradient text.** Single solid color. Emphasis via weight or size.
- **No side-stripe borders** (`border-left: 3px solid` colored). Full
  borders or background tints or leading numbers.
- **No identical card grids** repeating endlessly. Mix card sizes when the
  semantic weight is different.
- **No glassmorphism for decoration.** The existing `--glass` is used
  purposefully (phone mockup, tabbar). Don't spread it.
- **Mirko fixtures** stay literal in demo mode: `$4,820.40`, `$3,200`,
  `$50/wk`.

## Layout primitives

- `.card` — 16px padding, `var(--r-lg)`, `var(--sh-soft)`, `var(--border)`
  hairline.
- `.lrow` — 13px 2px padding, hairline top border, min-height 52px,
  `.t` = 13.5px weight 500 sans, `.s` = 11px mono `var(--meta)`,
  `.amt` = mono tabular-nums weight 600.
- `.tag` — 4px 11px, 10px mono, .08em tracking. `.ok` / `.live` / `.warnx`
  / `.dang` variants for state color.
- `.eyebrow` — 10px mono, .14em or .18em tracking, `var(--meta)`.
- `.btn` — 46px min-height, pill radius, .15s transition. `.acc` for
  primary, `.ghost` for secondary.
- `.seg` — pill tab group. Buttons inside are 36px min-height.

## When in doubt

Pick the existing primitive. The system is intentionally small — five web
components, six type scales, four radii, three shadows. If you're reaching
for a new pattern, check whether the existing one with a slight variation
works first.

The senior designer rule: **a senior reviewer should not be able to tell
the difference between handwritten markup and component output.** If a
provider-card sticks out on s28 because it's a different padding, it's
wrong. Match the system; don't extend it.
