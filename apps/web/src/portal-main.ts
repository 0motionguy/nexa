/**
 * NEXA vendor portal engine — x402 merchant surface (p01–p04).
 * Same delegation idioms as app-main.ts: hash-routed .scr screens, one click
 * listener for data-go / data-open / data-close / data-toast / data-copy /
 * data-swtoggle, toasts, bottom sheet. No globe on the portal.
 *
 * Security contract (carried over from app-main.ts): user-input values reach
 * the DOM via textContent only — innerHTML is never used with runtime data.
 */

export {};

function $<T extends HTMLElement = HTMLElement>(sel: string, ctx: ParentNode = document): T {
  const el = ctx.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}
function $$<T extends HTMLElement = HTMLElement>(sel: string, ctx: ParentNode = document): T[] {
  return Array.from(ctx.querySelectorAll<T>(sel));
}

const ACTION_SELECTOR = '[data-go],[data-open],[data-close],[data-toast],[data-copy]';
const NATIVE_ACTION_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

function setKeyboardAction(el: HTMLElement): void {
  if (NATIVE_ACTION_TAGS.has(el.tagName)) return;
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
}

function enhanceKeyboardActions(ctx: ParentNode = document): void {
  $$<HTMLElement>(ACTION_SELECTOR, ctx).forEach(setKeyboardAction);
}

/* Theme — honor the choice persisted by app-main.ts so a dark toggle on
   /app.html carries over here. Portal has no toggle of its own. */
(() => {
  const stored = localStorage.getItem('maze.theme');
  const choice = stored === 'light' || stored === 'dark'
    ? stored
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const stage = document.getElementById('stage');
  if (stage) stage.setAttribute('data-theme', choice);
})();

/* ── vendor ledger (mock, single source of truth) ── */
type ContractStatus = 'live' | 'test' | 'review' | 'paused';
interface Contract {
  name: string;
  method: string;
  path: string;
  price: number;
  cur: string;
  status: ContractStatus;
  prev?: ContractStatus;
  revToday: string;
  reqToday: string;
  success: string;
  settle: string;
  topAgent: string;
}
const contracts: Contract[] = [
  {
    name: 'Clip Analytics', method: 'GET', path: '/v1/clip-analytics', price: 0.003, cur: 'USDC',
    status: 'live', revToday: '$55.20', reqToday: '18,402', success: '98.7%', settle: '1.9s',
    topAgent: 'ResearchBot-01',
  },
  {
    name: 'Duplicate Check', method: 'GET', path: '/v1/duplicate-check', price: 0.001, cur: 'USDC',
    status: 'test', revToday: '$0.00', reqToday: '64 · test', success: '…', settle: '…', topAgent: '…',
  },
  {
    name: 'Premium Dataset', method: 'GET', path: '/v1/dataset/company', price: 0.08, cur: 'USDC',
    status: 'review', revToday: '$0.00', reqToday: '0', success: '…', settle: '…', topAgent: '…',
  },
];
let curContract = 0;

interface PayEvent {
  buyer: string;
  kind: 'Agent' | 'Human';
  av: string;
  hot: boolean;
  resource: string;
  amt: string;
  settled: boolean;
  http: string;
  ref: string;
  time: string;
  receipt: string;
}
const EVENTS: PayEvent[] = [
  {
    buyer: 'ResearchBot-01', kind: 'Agent', av: 'R1', hot: true,
    resource: 'GET /v1/clip-analytics', amt: '$0.003', settled: true,
    http: '402 → 200 OK', ref: '0x8c1f…e2d4', time: 'Today, 12:04:11',
    receipt: 'x402 receipt · GET /v1/clip-analytics · quote $0.003 USDC · X-PAYMENT verified · 200 OK in 1.8s · settled on Base · ref 0x8c1f…e2d4 · settlement complete',
  },
  {
    buyer: 'Human client', kind: 'Human', av: 'H', hot: false,
    resource: 'GET /v1/clip-analytics', amt: '$0.003', settled: true,
    http: '402 → 200 OK', ref: '0x3d92…c8a7', time: 'Today, 12:03:47',
    receipt: 'x402 receipt · GET /v1/clip-analytics · quote $0.003 USDC · X-PAYMENT verified · 200 OK in 2.1s · settled on Base · ref 0x3d92…c8a7 · settlement complete',
  },
  {
    buyer: 'MarketScan-03', kind: 'Agent', av: 'M3', hot: true,
    resource: 'GET /v1/clip-analytics', amt: '$0.003', settled: true,
    http: '402 → 200 OK', ref: '0x77b0…41aa', time: 'Today, 12:03:12',
    receipt: 'x402 receipt · GET /v1/clip-analytics · quote $0.003 USDC · X-PAYMENT verified · 200 OK in 1.7s · settled on Base · ref 0x77b0…41aa · settlement complete',
  },
  {
    buyer: 'ClipScout-12', kind: 'Agent', av: 'C1', hot: true,
    resource: 'GET /v1/clip-analytics', amt: '$0.003', settled: false,
    http: '402 · not retried', ref: '…', time: 'Today, 12:01:58',
    receipt: 'x402 quote · GET /v1/clip-analytics · 402 Payment required issued · $0.003 USDC quoted · X-PAYMENT never received · no settlement · no access granted',
  },
];

const TAG: Record<ContractStatus, readonly [string, string]> = {
  live: ['tag live', 'LIVE'],
  test: ['tag warnx', 'TEST'],
  review: ['tag warnx', 'REVIEW'],
  paused: ['tag', 'PAUSED'],
};

function fmtPrice(v: number): string {
  return '$' + v.toFixed(3);
}
function priceLine(c: Contract): string {
  return `${fmtPrice(c.price)} / request · ${c.cur}`;
}
function contractSub(c: Contract): string {
  return `${c.method} ${c.path} · ${fmtPrice(c.price)}/REQ · ${c.cur}`;
}
function setStatusTag(el: HTMLElement, status: ContractStatus): void {
  const [cls, label] = TAG[status];
  el.className = cls;
  el.textContent = label;
}

/* ── toasts ── */
function toast(msg: string, kind?: 'err'): void {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  const dot = document.createElement('i');
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(dot);
  t.appendChild(span);
  $('#toasts').appendChild(t);
  window.setTimeout(() => t.parentNode && t.remove(), 2800);
}

/* ── router ── */
const scrs = $$('.scr');

function closeOverlays(): void {
  $$('.ovl.on').forEach((o) => o.classList.remove('on'));
}

function go(id: string): void {
  if (!document.getElementById(id)) id = 'p01';
  closeOverlays();
  scrs.forEach((s) => s.classList.toggle('on', s.id === id));
  if (history.replaceState) history.replaceState(null, '', '#' + id);
  const b = $('#' + id).querySelector<HTMLElement>('.body');
  if (b) b.scrollTop = 0;
}

function openOvl(id: string): void {
  const o = document.getElementById(id);
  if (!o) return;
  if (id === 'priceSheet') {
    const c = contracts[curContract];
    if (c) {
      const range = $<HTMLInputElement>('#prRange');
      range.value = String(Math.min(0.1, Math.max(0.001, c.price)));
      $('#prV').textContent = (parseFloat(range.value) || 0.001).toFixed(3);
    }
  }
  o.classList.add('on');
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const g = target.closest<HTMLElement>('[data-go]');
  if (g) {
    e.preventDefault();
    const ct = g.getAttribute('data-contract');
    if (ct !== null) fillContract(parseInt(ct, 10));
    const ev = g.getAttribute('data-event');
    if (ev !== null) fillEvent(parseInt(ev, 10));
    go(g.getAttribute('data-go')!);
    return;
  }
  const op = target.closest<HTMLElement>('[data-open]');
  if (op) {
    openOvl(op.getAttribute('data-open')!);
    return;
  }
  const c = target.closest<HTMLElement>('[data-close]');
  if (c) {
    $('#' + c.getAttribute('data-close')!).classList.remove('on');
    return;
  }
  const sw = target.closest<HTMLElement>('[data-swtoggle]');
  if (sw) {
    sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') !== 'true' ? 'true' : 'false');
    return;
  }
  const tst = target.closest<HTMLElement>('[data-toast]');
  if (tst) {
    toast(tst.getAttribute('data-toast')!);
    return;
  }
  const cp = target.closest<HTMLElement>('[data-copy]');
  if (cp) {
    const prev = cp.textContent;
    const done = (t2: string) => {
      cp.textContent = t2;
      window.setTimeout(() => {
        cp.textContent = prev;
      }, 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cp.getAttribute('data-copy')!).then(
        () => done('COPIED ✓'),
        () => done('PREVIEW'),
      );
    } else {
      done('PREVIEW');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const action = (e.target as HTMLElement).closest<HTMLElement>(ACTION_SELECTOR);
  if (!action || NATIVE_ACTION_TAGS.has(action.tagName)) return;
  e.preventDefault();
  action.click();
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id) go(id);
});

/* ── p01: section seg ── */
function setSeg(n: string): void {
  $$('[data-pseg]').forEach((b) => {
    const selected = b.getAttribute('data-pseg') === n;
    b.classList.toggle('on', selected);
    b.setAttribute('aria-selected', String(selected));
    b.setAttribute('aria-controls', 'pseg' + b.getAttribute('data-pseg'));
    b.tabIndex = selected ? 0 : -1;
  });
  ['1', '2', '3', '4'].forEach((k) => {
    const panel = $('#pseg' + k);
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = k !== n;
  });
}
$$('[data-pseg]').forEach((b) => {
  b.addEventListener('click', () => setSeg(b.getAttribute('data-pseg') ?? '1'));
});

/* ── p01: endpoint pause switches ── */
function wireEndpointPause(swSel: string, tagSel: string, liveClass: string, liveLabel: string): void {
  $(swSel).addEventListener('click', () => {
    const sw = $(swSel);
    const paused = sw.getAttribute('aria-checked') === 'true';
    sw.setAttribute('aria-checked', String(!paused));
    const tag = $(tagSel);
    if (paused) {
      tag.className = liveClass;
      tag.textContent = liveLabel;
      toast('Endpoint live · agents can pay it now ✓');
    } else {
      tag.className = 'tag';
      tag.textContent = 'PAUSED';
      toast('Endpoint paused. Requests return 503.');
    }
  });
}
wireEndpointPause('#ep1Sw', '#ep1Tag', 'tag live', 'LIVE');
wireEndpointPause('#ep2Sw', '#ep2Tag', 'tag warnx', 'TEST');

/* ── p01 ↔ p03: contract list sync ── */
function syncContractRow(i: number): void {
  const c = contracts[i];
  if (!c) return;
  const row = document.querySelector<HTMLElement>(`#contractList [data-contract="${i}"]`);
  if (!row) return;
  const s = row.querySelector<HTMLElement>('.s');
  if (s) s.textContent = contractSub(c);
  const tag = row.querySelector<HTMLElement>('.tag');
  if (tag) setStatusTag(tag, c.status);
}

/* ── p02: create contract ── */
function chipValue(sel: string, fallback: string): string {
  const on = $$(sel).find((ch) => ch.classList.contains('onx'));
  return (on?.textContent ?? fallback).trim();
}
$$('[data-mchip]').forEach((ch) => {
  ch.addEventListener('click', () => {
    $$('[data-mchip]').forEach((o) => o.classList.toggle('onx', o === ch));
  });
});
$$('[data-cchip]').forEach((ch) => {
  ch.addEventListener('click', () => {
    $$('[data-cchip]').forEach((o) => o.classList.toggle('onx', o === ch));
  });
});
$('#ctCreate').addEventListener('click', () => {
  const name = $<HTMLInputElement>('#ctName').value.trim();
  if (!name) {
    toast('Name the contract first.', 'err');
    return;
  }
  let path = $<HTMLInputElement>('#ctPath').value.trim() || '/v1/endpoint';
  if (!path.startsWith('/')) path = '/' + path;
  const price = Math.abs(parseFloat($<HTMLInputElement>('#ctPrice').value.replace(',', '.'))) || 0.003;
  const test = $('#ctTest').getAttribute('aria-checked') === 'true';
  const c: Contract = {
    name,
    path,
    price,
    method: chipValue('[data-mchip]', 'GET'),
    cur: chipValue('[data-cchip]', 'USDC'),
    status: test ? 'test' : 'live',
    revToday: '$0.00',
    reqToday: '0',
    success: '…',
    settle: '…',
    topAgent: '…',
  };
  const idx = contracts.push(c) - 1;

  /* DOM-built lrow — user input never touches innerHTML */
  const row = document.createElement('div');
  row.className = 'lrow';
  row.dataset['go'] = 'p03';
  row.dataset['contract'] = String(idx);
  row.style.cursor = 'pointer';
  setKeyboardAction(row);
  const av = document.createElement('span');
  av.className = 'agent-av';
  av.textContent = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'X4';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = name;
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = contractSub(c);
  grow.appendChild(t);
  grow.appendChild(document.createElement('br'));
  grow.appendChild(s);
  const tag = document.createElement('span');
  setStatusTag(tag, c.status);
  row.appendChild(av);
  row.appendChild(grow);
  row.appendChild(tag);
  $('#contractList').appendChild(row);

  toast(test ? 'Contract created in test mode. Payments are simulated.' : 'Endpoint live · agents can pay it now ✓');
  setSeg('2');
  go('p01');
});

/* ── p03: contract detail ── */
function fillContract(i: number): void {
  const c = contracts[i];
  if (!c) return;
  curContract = i;
  $('#ctdTitle').textContent = c.name;
  setStatusTag($('#ctdTag'), c.status);
  $('#ctdPath').textContent = `${c.method} ${c.path} · ${priceLine(c)}`;
  $('#ctdRev').textContent = c.revToday;
  $('#ctdReq').textContent = c.reqToday;
  $('#ctdSucc').textContent = c.success;
  $('#ctdSettle').textContent = c.settle;
  $('#ctdTop').textContent = c.topAgent;
  $('#ctdPause').setAttribute('aria-checked', String(c.status === 'paused'));
  const flagship = i === 0;
  $('#ctdLog').hidden = !flagship;
  $('#ctdLogHead').hidden = !flagship;
  $('#ctdEmpty').hidden = flagship;
}

$('#ctdPause').addEventListener('click', () => {
  const c = contracts[curContract];
  if (!c) return;
  const pausing = c.status !== 'paused';
  if (pausing) {
    c.prev = c.status;
    c.status = 'paused';
  } else {
    c.status = c.prev ?? 'live';
  }
  setStatusTag($('#ctdTag'), c.status);
  $('#ctdPause').setAttribute('aria-checked', String(pausing));
  syncContractRow(curContract);
  toast(pausing ? 'Contract paused. No new payments accepted.' : 'Endpoint live · agents can pay it now ✓');
});

/* ── price sheet ── */
$('#prRange').addEventListener('input', () => {
  $('#prV').textContent = (parseFloat($<HTMLInputElement>('#prRange').value) || 0.001).toFixed(3);
});
$('#prSave').addEventListener('click', () => {
  const c = contracts[curContract];
  if (!c) return;
  c.price = parseFloat($<HTMLInputElement>('#prRange').value) || c.price;
  $('#ctdPath').textContent = `${c.method} ${c.path} · ${priceLine(c)}`;
  if (curContract === 0) $('#ep1Price').textContent = priceLine(c);
  syncContractRow(curContract);
  $('#priceSheet').classList.remove('on');
  toast(`Price updated · ${fmtPrice(c.price)} / request ✓`);
});

/* ── p04: event detail ── */
function fillEvent(i: number): void {
  const ev = EVENTS[i];
  if (!ev) return;
  const av = $('#evAv');
  av.textContent = ev.av;
  av.className = 'agent-av' + (ev.hot ? ' hot' : '');
  $('#evName').textContent = ev.buyer;
  const amt = $('#evAmt');
  amt.textContent = ev.settled ? '+' + ev.amt : ev.amt;
  amt.style.color = ev.settled ? 'var(--success)' : 'var(--meta)';
  const tag = $('#evTag');
  tag.textContent = ev.settled ? 'SETTLED' : 'PAYMENT REQUIRED';
  tag.className = 'tag ' + (ev.settled ? 'ok' : 'warnx');
  $('#evBuyer').textContent = `${ev.buyer} · ${ev.kind}`;
  $('#evRes').textContent = ev.resource;
  $('#evHttp').textContent = ev.http;
  $('#evRef').textContent = ev.ref;
  $('#evTime').textContent = ev.time;
  $('#evAdv').textContent = ev.receipt;
}

/* ── boot ── */
fillContract(0);
enhanceKeyboardActions();
setSeg('1');
go(location.hash.slice(1) || 'p01');
