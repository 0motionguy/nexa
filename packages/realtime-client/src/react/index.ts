/**
 * React hooks layer for the realtime client. Importable from
 * `@nexa/realtime-client/react` so consumers without React (Node tests,
 * vanilla browser scripts) don't pull these in by default.
 */

export { RealtimeProvider, type RealtimeProviderProps } from './Provider.js';
export {
  useAccountUpdates,
  useCandle,
  useFills,
  useOrderbook,
  useOrderUpdates,
  usePredictionPrice,
  useRealtimeClient,
  useStockPrice,
  useTicker,
  useTickerBatch,
  useTradeTick,
} from './hooks.js';
