import type { NexaClient } from './index.js';

type Assert<T extends true> = T;
type Internal = Awaited<ReturnType<NexaClient['transfers']['internal']>>;
type External = Awaited<ReturnType<NexaClient['transfers']['external']>>;
type HlDeposit = Awaited<ReturnType<NexaClient['transfers']['hlDeposit']>>;

export type InternalTransferFieldsMatchRoute = Assert<
  Internal extends { etaSec: number; demo: boolean } ? true : false
>;
export type InternalTransferIncludesWithdrawalState = Assert<
  'hl_withdrawing' extends Internal['status'] ? true : false
>;
export type ExternalTransferFieldsMatchRoute = Assert<
  External extends { chain: 'base'; submittedUnknown?: boolean } ? true : false
>;
export type HlDepositFieldsMatchRoute = Assert<
  HlDeposit extends {
    callId: string | null;
    transferId: string;
    status: string;
    idempotent: boolean;
    submittedUnknown?: boolean;
  }
    ? true
    : false
>;
export type HlDepositAllowsUnknownCallId = Assert<null extends HlDeposit['callId'] ? true : false>;
