/**
 * x402 payee resolution — answers "who actually receives the USDC for this
 * endpoint?" before the EIP-3009 typed-data is signed.
 *
 * Stack upgrades Phase 3.
 *
 * Lookup order:
 *   1. Caller-supplied contractId (preferred, when the route already knows it).
 *   2. Endpoint-path global match — `findContractByEndpoint` scans every
 *      seller's published contracts for a path equal to the agent's requested
 *      endpoint. When the path is a full URL the URL.pathname is compared.
 *   3. Fallback — the agent's own address (legacy self-pay). The caller MUST
 *      log a warn at the call site whenever this branch fires so production
 *      logs can spot vendors who never set up a payee column.
 */

import { store } from '../store/index.js';
import { log } from './log.js';

/**
 * Resolve the EIP-3009 `to` address for an x402 settlement.
 *
 * - `contractId` is the strongest hint and skips path lookup.
 * - `endpoint` is the URL/host the agent paid; used to find a matching vendor
 *   contract if `contractId` is absent.
 * - `fallbackAddress` is the agent's own address; returned only when no contract
 *   has a `payeeAddress`. The caller should log a warn in that case.
 */
export async function resolvePayeeAddress(
  opts: {
    contractId?: string | null;
    endpoint?: string | null;
    fallbackAddress: string;
  },
): Promise<{ address: string; source: 'contract' | 'fallback'; contractId: string | null }> {
  if (opts.contractId) {
    const contract = await findContractByIdAcrossSellers(opts.contractId);
    if (contract?.payeeAddress) {
      return { address: contract.payeeAddress, source: 'contract', contractId: contract.id };
    }
  }
  if (opts.endpoint) {
    const path = pathFromEndpoint(opts.endpoint);
    const contract = await findContractByEndpoint(path);
    if (contract?.payeeAddress) {
      return { address: contract.payeeAddress, source: 'contract', contractId: contract.id };
    }
  }
  log.warn(
    { contractId: opts.contractId ?? null, endpoint: opts.endpoint ?? null },
    'x402-payee: no contract payee_address found, falling back to self-pay',
  );
  return { address: opts.fallbackAddress, source: 'fallback', contractId: null };
}

function pathFromEndpoint(endpoint: string): string {
  // Accept full URLs ("https://api.x.com/foo"), bare paths ("/foo"), and
  // host-only ("api.x.com/foo"). Return the pathname for matching.
  // A bare leading-slash path is returned as-is (URL constructor would
  // misparse "https:///v1/path" as host="v1", pathname="/path").
  if (endpoint.startsWith('/')) return endpoint;
  try {
    const url = new URL(endpoint.startsWith('http') ? endpoint : 'https://' + endpoint);
    return url.pathname || endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * Defer the actual cross-seller lookup to the Store impls so the InMemory and
 * Postgres backends can scan their own indices. We don't add the method to the
 * Store interface (Phase 3 keeps the typed surface narrow) — instead we read
 * the optional methods at runtime and fall through cleanly when absent.
 */
type ContractLookupStore = {
  findContractByEndpoint?(endpointPath: string): Promise<{
    id: string;
    payeeAddress: string | null;
  } | null>;
  findContractById?(contractId: string): Promise<{
    id: string;
    payeeAddress: string | null;
  } | null>;
};

async function findContractByEndpoint(
  endpointPath: string,
): Promise<{ id: string; payeeAddress: string | null } | null> {
  const s = store as unknown as ContractLookupStore;
  if (!s.findContractByEndpoint) return null;
  return s.findContractByEndpoint(endpointPath);
}

async function findContractByIdAcrossSellers(
  contractId: string,
): Promise<{ id: string; payeeAddress: string | null } | null> {
  const s = store as unknown as ContractLookupStore;
  if (!s.findContractById) return null;
  return s.findContractById(contractId);
}
