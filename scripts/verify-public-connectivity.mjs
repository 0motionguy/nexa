import { resolve4, resolve6, resolveCname } from 'node:dns/promises';

// maze.bank / maze.to DNS is deferred (domain cutover has not happened yet).
// Until MAZE_BANK_DNS_LIVE=1 those endpoints are reported but do not fail the
// gate — otherwise `pnpm verify:public` permanently fails against dead DNS.
const mazeBankDnsLive = process.env.MAZE_BANK_DNS_LIVE === '1';

const endpoints = [
  {
    name: 'apex',
    url: process.env.MAZE_PUBLIC_APEX_URL ?? 'https://maze.bank/healthz',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'app',
    url: process.env.NEXA_PUBLIC_APP_URL ?? 'https://app.maze.bank/app.html',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'developer-console',
    url: process.env.NEXA_PUBLIC_PORTAL_URL ?? 'https://dev.maze.bank/developers.html',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'api',
    url: process.env.NEXA_PUBLIC_API_URL ?? 'https://api.maze.bank/healthz',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'checkout',
    url: process.env.MAZE_PUBLIC_CHECKOUT_URL ?? 'https://checkout.maze.bank/healthz',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'mcp-health',
    url: process.env.MAZE_PUBLIC_MCP_HEALTH_URL ?? 'https://mcp.maze.bank/healthz',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'payment-link',
    url: process.env.MAZE_PUBLIC_PAY_URL ?? 'https://maze.to/pay/health-check',
    optional: !mazeBankDnsLive,
  },
  {
    name: 'preview-api',
    url: process.env.MAZE_PREVIEW_API_URL ?? 'https://maze.aiso.tools/api/healthz',
  },
  {
    name: 'preview-claim',
    url: process.env.MAZE_PREVIEW_CLAIM_URL ?? 'https://maze.aiso.tools/claim/health-check',
  },
  {
    name: 'preview-mcp',
    url: process.env.MAZE_PREVIEW_MCP_URL ?? 'https://maze.aiso.tools/mcp',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    expectedStatuses: [401],
  },
  {
    name: 'retained-api-alias',
    url: process.env.NEXA_RETAINED_API_URL ?? 'https://nexa.aiso.tools/api/healthz',
  },
];

async function resolveHost(hostname) {
  const lookups = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
    resolveCname(hostname),
  ]);
  const values = lookups
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);
  if (values.length === 0) {
    throw new Error(`DNS did not resolve for ${hostname}`);
  }
  return values;
}

async function fetchStatus(endpoint) {
  const expectedStatuses = endpoint.expectedStatuses ?? [];
  const response = await fetch(endpoint.url, {
    method: endpoint.method ?? 'GET',
    headers: endpoint.headers,
    body: endpoint.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const statusOk = expectedStatuses.length > 0
    ? expectedStatuses.includes(response.status)
    : response.status >= 200 && response.status < 400;
  if (!statusOk) {
    throw new Error(`HTTP ${response.status} from ${endpoint.url}`);
  }
  const server = response.headers.get('server')?.toLowerCase() ?? '';
  if (!server.includes('cloudflare')) {
    throw new Error(`expected Cloudflare edge for ${endpoint.url}, got Server=${server || '<missing>'}`);
  }
  const vercelHeader = Array.from(response.headers.keys()).find((name) => name.toLowerCase().startsWith('x-vercel'));
  if (vercelHeader) {
    throw new Error(`unexpected Vercel header ${vercelHeader} from ${endpoint.url}`);
  }
  return response.status;
}

let failed = false;
for (const endpoint of endpoints) {
  const parsed = new URL(endpoint.url);
  try {
    const dns = await resolveHost(parsed.hostname);
    const status = await fetchStatus(endpoint);
    console.log(`${endpoint.name}: ok dns=${dns.join(',')} http=${status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (endpoint.optional) {
      console.warn(`${endpoint.name}: SKIP (maze.bank DNS cutover pending) — ${message}`);
    } else {
      failed = true;
      console.error(`${endpoint.name}: ${message}`);
    }
  }
}

if (failed) {
  process.exitCode = 1;
}
