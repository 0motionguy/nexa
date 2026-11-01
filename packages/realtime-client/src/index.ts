/**
 * `@nexa/realtime-client` — shared client surface for the realtime fan-out
 * hub. Both NEO (Expo / React Native + web target) and MAZE (Vite SPA)
 * import from here so they speak the same protocol the server emits.
 *
 * This entry point is intentionally typescript-only for the initial Phase B
 * cut: it exposes the wire types + topic grammar + a couple of ergonomic
 * topic constructors. The React hooks + Zustand store land in the next
 * commit alongside the workspace hoist that adds `../neo` to
 * `pnpm-workspace.yaml`.
 *
 * Until then, NEO and MAZE can ALREADY import the topic helpers to stop
 * hand-templating strings like `ticker:hl:BTC` everywhere — they'll just
 * keep using their existing per-component WS clients for the transport.
 */

export type {
  AccountEvent,
  AccountPosition,
  BookEvent,
  BookLevel,
  CandleEvent,
  ClientOp,
  FeedEvent,
  FillEvent,
  Interval,
  MarketOrderStatus,
  MarketVenue,
  OrderEvent,
  ServerErrCode,
  ServerOp,
  TickEvent,
  Topic,
  TopicKind,
  TradeEvent,
  VenueTag,
} from './types.js';

export {
  bookTopic,
  candleTopic,
  format,
  isValid,
  parse,
  predictionsTopic,
  privAccountTopic,
  privFillsTopic,
  privOrdersTopic,
  stockTopic,
  tickerTopic,
  tradesTopic,
  type ParsedTopic,
} from './topic.js';

export { RealtimeStore, type Listener, type StoreSnapshot } from './store.js';
export { RefCountSet } from './refcount.js';
export { SseTransport, type SseTransportOptions } from './transport/sse.js';
export { WsTransport, type WsTransportOptions } from './transport/ws.js';
export { RealtimeClient, type RealtimeClientOptions } from './RealtimeClient.js';
