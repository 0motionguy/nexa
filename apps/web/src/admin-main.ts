/**
 * Admin console — talks to the existing /admin routes with the
 * ADMIN_TOKEN bearer. In-memory token only (never persisted).
 *
 * Routes used:
 *   POST /admin/cohort        { userId, cohort: string | null }
 *   GET  /admin/test-users    ?cohort=&onchain=
 *   POST /admin/withdraw-all  { userId, destinationAddress, chain }
 *
 * Audit 2026-06-19 — built so Mirko can manage the test cohort without
 * curl/Postman. Single page; no router; no framework.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

let adminToken: string | null = null;

const apiBase = (): string => (location.host === 'localhost' || location.hostname === '127.0.0.1' ? '/api' : '');

interface AdminRequestOpts {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

async function admin<T = unknown>(path: string, opts: AdminRequestOpts = {}): Promise<{ ok: true; data: T } | { ok: false; status: number; body: unknown }> {
  if (!adminToken) {
    return { ok: false, status: 0, body: { error: { code: 'no_token', message: 'connect with a token first' } } };
  }
  const url = new URL(`${apiBase()}/admin${path}`, location.href);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { authorization: `Bearer ${adminToken}` };
  if (opts.body) headers['content-type'] = 'application/json';
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body) init.body = JSON.stringify(opts.body);
  try {
    const res = await fetch(url.toString(), init);
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) return { ok: false, status: res.status, body };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, status: 0, body: { error: { code: 'network', message: e instanceof Error ? e.message : String(e) } } };
  }
}

function setStatus(el: HTMLElement, kind: 'ok' | 'bad' | 'idle', message: string): void {
  el.className = `status ${kind}`;
  el.textContent = message;
}

function setConnStatus(state: 'connected' | 'disconnected' | 'error' | 'idle'): void {
  const pill = $('connStatus');
  const label = state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'disconnected' : 'not connected';
  pill.textContent = label;
  pill.className = `pill ${state === 'connected' ? 'ok' : state === 'error' ? 'bad' : 'idle'}`;
}

/* ─── token ────────────────────────────────────────────────────────────── */

$('connectBtn').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('adminToken');
  const token = input.value.trim();
  if (!token) {
    setConnStatus('error');
    return;
  }
  adminToken = token;
  // Probe a cheap admin route to verify the token without side effects.
  const probe = await admin('/test-users', { query: { cohort: 'connectivity-probe-zzz', onchain: 'false' } });
  if (probe.ok) {
    setConnStatus('connected');
  } else if (probe.status === 401) {
    setConnStatus('error');
    adminToken = null;
  } else {
    // Any other status is fine — token works, route accepted auth.
    setConnStatus('connected');
  }
});

$('clearTokenBtn').addEventListener('click', () => {
  adminToken = null;
  $<HTMLInputElement>('adminToken').value = '';
  setConnStatus('disconnected');
});

/* ─── cohort tag ───────────────────────────────────────────────────────── */

async function setCohort(cohort: string | null): Promise<void> {
  const userId = $<HTMLInputElement>('cohortUserId').value.trim();
  const statusEl = $('cohortStatus');
  if (!userId) {
    setStatus(statusEl, 'bad', 'userId required');
    return;
  }
  const r = await admin('/cohort', { method: 'POST', body: { userId, cohort } });
  if (r.ok) {
    setStatus(statusEl, 'ok', JSON.stringify(r.data, null, 2));
  } else {
    setStatus(statusEl, 'bad', `${r.status}\n${JSON.stringify(r.body, null, 2)}`);
  }
}

$('cohortSetBtn').addEventListener('click', () => setCohort($<HTMLInputElement>('cohortTag').value.trim()));
$('cohortClearBtn').addEventListener('click', () => setCohort(null));

/* ─── dashboard ───────────────────────────────────────────────────────── */

interface TestUserRow {
  id: string;
  email: string;
  name: string;
  cohort: string | null;
  kycStatus: string;
  killSwitch: boolean;
  wallets: { evm: string | null; solana: string | null };
  balances: { ledgerUsd: number; ledgerEarnUsd: number; earnApy: number; onchainUsdcBase: string | null };
  flags: { hlBuilderApproved: boolean; hlBuilderMaxFeeTenthsBp: number | null; pmClobDerived: boolean };
  positions: { hyperliquid: number; polymarket: number };
}

interface DashboardResponse {
  ok: boolean;
  cohort: string;
  count: number;
  users: TestUserRow[];
}

function renderDashboard(data: DashboardResponse): void {
  const host = $('dashboardTableHost');
  // Replace, never use innerHTML on host. textContent='' clears children.
  host.textContent = '';
  $('dashboardCount').textContent = `${data.count} user${data.count === 1 ? '' : 's'}`;
  if (data.count === 0) {
    const empty = document.createElement('p');
    empty.style.color = 'var(--muted)';
    empty.textContent = `No users tagged with cohort "${data.cohort}". Use the section above to tag.`;
    host.appendChild(empty);
    return;
  }
  const table = document.createElement('table');
  table.appendChild(buildHead([
    'Email',
    'EVM wallet',
    'Solana wallet',
    'Ledger USD',
    'On-chain USDC',
    'HL builder',
    'PM CLOB',
    'Positions',
    'KYC',
  ]));
  const body = document.createElement('tbody');
  for (const u of data.users) {
    const tr = document.createElement('tr');
    tr.appendChild(emailCell(u.email, u.id));
    tr.appendChild(addrCell(u.wallets.evm));
    tr.appendChild(addrCell(u.wallets.solana));
    tr.appendChild(textCell(`$${u.balances.ledgerUsd.toFixed(2)}`));
    tr.appendChild(textCell(u.balances.onchainUsdcBase != null ? `$${parseFloat(u.balances.onchainUsdcBase).toFixed(2)}` : '—'));
    tr.appendChild(pillCell(
      u.flags.hlBuilderApproved ? 'ok' : 'idle',
      u.flags.hlBuilderApproved ? `${(u.flags.hlBuilderMaxFeeTenthsBp ?? 0) / 10}bps` : 'no',
    ));
    tr.appendChild(pillCell(
      u.flags.pmClobDerived ? 'ok' : 'idle',
      u.flags.pmClobDerived ? 'derived' : 'no',
    ));
    tr.appendChild(textCell(`HL ${u.positions.hyperliquid} · PM ${u.positions.polymarket}`));
    tr.appendChild(pillCell(
      u.kycStatus === 'verified' ? 'ok' : u.kycStatus === 'failed' ? 'bad' : 'warn',
      u.kycStatus,
    ));
    body.appendChild(tr);
  }
  table.appendChild(body);
  host.appendChild(table);
}

function buildHead(labels: string[]): HTMLTableSectionElement {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

function textCell(content: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.textContent = content;
  return cell;
}

/**
 * Two-line cell: primary text (email) then a small muted id underneath. All
 * fields use textContent so any `<script>` in user data renders inert.
 */
function emailCell(email: string, id: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.textContent = email;
  cell.appendChild(document.createElement('br'));
  const idEl = document.createElement('span');
  idEl.style.color = 'var(--muted)';
  idEl.style.fontSize = '11px';
  idEl.textContent = id;
  cell.appendChild(idEl);
  return cell;
}

function addrCell(addr: string | null): HTMLTableCellElement {
  const cell = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'addr';
  span.textContent = addr ?? '—';
  cell.appendChild(span);
  return cell;
}

function pillCell(kind: 'ok' | 'warn' | 'bad' | 'idle', text: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  const span = document.createElement('span');
  span.className = `pill ${kind}`;
  span.textContent = text;
  cell.appendChild(span);
  return cell;
}

$('dashboardRefreshBtn').addEventListener('click', async () => {
  const cohort = $<HTMLInputElement>('dashboardCohort').value.trim() || 'tester-2026Q3';
  const onchain = $<HTMLInputElement>('dashboardOnchain').checked ? 'true' : 'false';
  const statusEl = $('dashboardStatus');
  setStatus(statusEl, 'idle', 'loading…');
  const r = await admin<DashboardResponse>('/test-users', { query: { cohort, onchain } });
  if (r.ok) {
    renderDashboard(r.data);
    setStatus(statusEl, 'ok', `loaded ${r.data.count} user${r.data.count === 1 ? '' : 's'}`);
  } else {
    setStatus(statusEl, 'bad', `${r.status}\n${JSON.stringify(r.body, null, 2)}`);
  }
});

/* ─── withdraw-all ────────────────────────────────────────────────────── */

$('withdrawBtn').addEventListener('click', async () => {
  const userId = $<HTMLInputElement>('withdrawUserId').value.trim();
  const destinationAddress = $<HTMLInputElement>('withdrawDestination').value.trim();
  const chain = $<HTMLSelectElement>('withdrawChain').value as 'base' | 'solana';
  const statusEl = $('withdrawStatus');
  if (!userId || !destinationAddress) {
    setStatus(statusEl, 'bad', 'userId AND destination required');
    return;
  }
  if (!confirm(`Drain ${chain.toUpperCase()} balance from ${userId} → ${destinationAddress}?\n\nThis is irreversible. Make sure the destination is correct.`)) {
    return;
  }
  setStatus(statusEl, 'idle', 'submitting…');
  const r = await admin('/withdraw-all', { method: 'POST', body: { userId, destinationAddress, chain } });
  if (r.ok) {
    setStatus(statusEl, 'ok', JSON.stringify(r.data, null, 2));
  } else {
    setStatus(statusEl, 'bad', `${r.status}\n${JSON.stringify(r.body, null, 2)}`);
  }
});

setConnStatus('idle');
