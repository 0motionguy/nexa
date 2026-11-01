# `@nexa/realtime-client`

Shared client for the NEXA realtime fan-out hub. Used by both **NEO** (Expo / React Native + web) and **MAZE** (Vite + vanilla web components) so they speak the same protocol the server emits.

- **Endpoint:** `/ws/markets` (public alias) or `/v1/stream/ws` (legacy)
- **SSE companion:** `/v1/stream/sse`
- **Schemas:** `@nexa/shared-zod` exports `FeedEventZ`, `ClientOpZ`, `ServerOpZ`
- **Architecture:** see [docs/REALTIME-MARKETS.md](../../docs/REALTIME-MARKETS.md)

## Imports

```ts
// Framework-neutral core + topic helpers + types
import {
  RealtimeClient,
  WsTransport,
  SseTransport,
  RealtimeStore,
  RefCountSet,
  tickerTopic,
  candleTopic,
  bookTopic,
  tradesTopic,
  predictionsTopic,
  stockTopic,
  type FeedEvent,
  type Topic,
  type VenueTag,
} from "@nexa/realtime-client";

// React surface (optional sub-export — only pulled in by React consumers)
import {
  RealtimeProvider,
  useRealtimeClient,
  useTicker,
  useCandle,
  useOrderbook,
  useTradeTick,
  useTickerBatch,
  usePredictionPrice,
  useStockPrice,
} from "@nexa/realtime-client/react";
```

## Vanilla JS (MAZE pattern)

MAZE's `apps/web/src/app-main.ts` wires `WsTransport` directly with a small ref-counted topic set. The full pattern is reproduced below — the key moves are (1) mint a stream ticket per connect, (2) target `/ws/markets`, (3) ref-count topics so opening + closing a market sheet doesn't churn the underlying socket.

```ts
import {
  WsTransport,
  tickerTopic,
  candleTopic,
  type FeedEvent,
  type Topic,
} from "@nexa/realtime-client";

const API_BASE = "/api"; // or absolute; trailing slash tolerated

// 1) Stream-ticket minter — server rejects long session JWTs in URLs.
const mintTicket = async () => {
  const res = await fetch(`${API_BASE}/v1/stream/ticket`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`mintTicket: ${res.status}`);
  const { token } = await res.json();
  if (!token) throw new Error("mintTicket: no token");
  return token as string;
};

// 2) Open ONE WsTransport for the whole app. Topics are ref-counted by the
//    caller — the transport just forwards sub/unsub frames.
let transport: WsTransport | null = null;
const subscribed = new Map<Topic, number>();

function dispatch(event: FeedEvent): void {
  if (event.t === "tick") {
    // mutate your view model here
  }
}

function ensureTransport(topics: Topic[]): void {
  if (transport) return;
  transport = new WsTransport({
    baseUrl: API_BASE,
    path: "/ws/markets", // legacy default would be /v1/stream/ws
    mintTicket,
    topics,
    onEvent: dispatch,
  });
}

function acquire(topic: Topic): void {
  const prev = subscribed.get(topic) ?? 0;
  subscribed.set(topic, prev + 1);
  if (prev > 0) return;
  if (transport) transport.addTopics([topic]);
  else ensureTransport([topic]);
}

function release(topic: Topic): void {
  const prev = subscribed.get(topic) ?? 0;
  if (prev <= 1) {
    subscribed.delete(topic);
    transport?.removeTopics([topic]);
  } else {
    subscribed.set(topic, prev - 1);
  }
}

// 3) Use it.
acquire(tickerTopic("hl", "BTC"));
acquire(candleTopic("hl", "BTC", "1m"));
// …on sheet close:
release(tickerTopic("hl", "BTC"));
release(candleTopic("hl", "BTC", "1m"));
```

When the last topic is released and the user navigates away, call `transport.close()` on `pagehide` and null out the reference. MAZE does this in [`apps/web/src/app-main.ts`](../../apps/web/src/app-main.ts) (`window.addEventListener('pagehide', …)`).

## React (NEO pattern)

Wrap once at the root, then call ergonomic per-topic hooks:

```tsx
import { RealtimeProvider, useTicker, useCandle } from "@nexa/realtime-client/react";

function App() {
  return (
    <RealtimeProvider baseUrl="https://api.maze.bank" token={sessionJwt}>
      <Markets />
    </RealtimeProvider>
  );
}

function Row({ coin }: { coin: string }) {
  const tick = useTicker(coin, "hl");                  // ticker:hl:<coin>
  const candle = useCandle(coin, "1m", "hl");          // candle:hl:<coin>:1m
  return <Text>{tick?.px ?? "—"}</Text>;
}
```

Hooks tolerate a missing provider (return `undefined`) so feature-flagging "render with provider only when ready" is a one-line conditional.

`useTickerBatch(symbols, venue)` returns a `Map<Topic, TickEvent>` — the right shape for FlatList rows. The underlying transport sees one consolidated `{op:'sub', topics:[…]}` per render that adds/removes symbols; it never reconnects.

## Authentication

| Credential | Where it goes | Notes |
|---|---|---|
| Session JWT (Bearer) | `Authorization: Bearer <jwt>` header | Standard cookie/Bearer accepted |
| Session cookie | `nexa_session=<jwt>` (browser) | Used by `defaultMintTicket` |
| Stream ticket | `?token=<ticket>` query param | 60s TTL, single-use, replay-guarded |

Full session JWTs are **rejected** from `?token=`. EventSource clients (no header support) use the ticket flow; WS clients can use either.

## Topic grammar

`kind:venue:symbol[:param]` — colon-separated, lowercase. See [docs/REALTIME-MARKETS.md](../../docs/REALTIME-MARKETS.md) for the full table. Helpers in `topic.ts` cover the common cases.

## Tests

```bash
pnpm --filter @nexa/realtime-client test
```

The package keeps a hand-mirrored TS-only copy of the wire types so the mobile bundle doesn't pull zod at runtime. The server's `apps/api/src/realtime/realtime.spec.ts` includes a cross-package invariant that fires if the two type definitions drift.
