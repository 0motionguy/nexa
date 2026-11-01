/**
 * lib/args.mjs — CLI parsing + the staged gate ladder (spec point 3:
 * "ramp/hold from --gate presets 0|1|2|3|4|5 matching the staged plan
 * (25/100/250/500/1000/soak-500) with --users/--duration overrides").
 */

import { GATES } from './metrics.mjs';

/** users/durationSeconds ladder. Gate 5 is the soak: same concurrency as
 * gate 3 (500), held far longer to catch slow leaks/drift. */
export const GATE_PRESETS = Object.freeze({
  0: Object.freeze({ users: 25, durationSeconds: 60, label: 'smoke-25' }),
  1: Object.freeze({ users: 100, durationSeconds: 120, label: 'ramp-100' }),
  2: Object.freeze({ users: 250, durationSeconds: 180, label: 'ramp-250' }),
  3: Object.freeze({ users: 500, durationSeconds: 300, label: 'ramp-500' }),
  4: Object.freeze({ users: 1000, durationSeconds: 600, label: 'cert-1000' }),
  5: Object.freeze({ users: 500, durationSeconds: 3600, label: 'soak-500' }),
});

const GATE_KEY_BY_CLI_FLAG = {
  'p95-read-edge': 'readP95EdgeMs',
  'p95-read-origin': 'readP95OriginMs',
  'p95-authed': 'authedP95Ms',
  'ws-ready-rate': 'wsReadyRatePct',
  'p95-ready': 'wsReadyP95Ms',
  'event-lag-p95': 'eventLagP95Ms',
  'event-lag-p99': 'eventLagP99Ms',
  'max-disconnects-per-hour': 'unplannedDisconnectsPerHourMax',
  'max-cross-user-events': 'crossUserPrivateEventsMax',
  'max-idempotency-mismatches': 'idempotencyReplayMismatchesMax',
};

/** Minimal, dependency-free `--flag value` / `--flag` boolean parser —
 * same convention as scripts/load-gate.mjs. */
function tokenize(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args.set(a.slice(2), next); i += 1; }
      else args.set(a.slice(2), 'true');
    }
  }
  return args;
}

export class UsageError extends Error {}

export function parseArgs(argv, env = process.env) {
  const raw = tokenize(argv);
  const gateNum = raw.has('gate') ? Number(raw.get('gate')) : null;
  if (gateNum !== null && !(gateNum in GATE_PRESETS)) {
    throw new UsageError(`--gate must be one of ${Object.keys(GATE_PRESETS).join('|')}, got "${raw.get('gate')}"`);
  }
  const preset = gateNum !== null ? GATE_PRESETS[gateNum] : GATE_PRESETS[0];

  const users = Number(raw.get('users') ?? preset.users);
  const durationSeconds = Number(raw.get('duration') ?? preset.durationSeconds);
  if (!Number.isFinite(users) || users <= 0) throw new UsageError(`--users must be a positive number, got "${raw.get('users')}"`);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new UsageError(`--duration must be a positive number of seconds, got "${raw.get('duration')}"`);

  const tokensFile = raw.get('tokens-file') ?? env.NEXA_LOAD_TOKENS_FILE ?? null;
  const selfTest = raw.get('self-test') === 'true';
  if (!tokensFile && !selfTest) {
    throw new UsageError('--tokens-file (or env NEXA_LOAD_TOKENS_FILE) is required outside --self-test — refuse to fabricate identities. See README.md "Identity pool".');
  }

  const gates = { ...GATES };
  for (const [flag, key] of Object.entries(GATE_KEY_BY_CLI_FLAG)) {
    if (raw.has(flag)) {
      const v = Number(raw.get(flag));
      if (!Number.isFinite(v)) throw new UsageError(`--${flag} must be a number, got "${raw.get(flag)}"`);
      gates[key] = v;
    }
  }

  const writeAllowlist = (raw.get('write-allowlist') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return {
    base: (raw.get('base') ?? 'https://nexa.aiso.tools/api').replace(/\/$/, ''),
    tokensFile,
    gate: gateNum ?? 0,
    gateLabel: preset.label,
    users,
    durationSeconds,
    mix: raw.get('mix') ?? null,
    enableWrites: raw.get('enable-writes') === 'true',
    writeAllowlist,
    out: raw.get('out') ?? null,
    selfTest,
    apiReplicas: raw.has('api-replicas') ? Number(raw.get('api-replicas')) : null,
    schedulerReplicas: raw.has('scheduler-replicas') ? Number(raw.get('scheduler-replicas')) : null,
    // Provenance overrides for containerized runs where the harness dir is
    // mounted without the git repo / migrations tree around it.
    neoSha: raw.get('neo-sha') ?? null,
    nexaSha: raw.get('nexa-sha') ?? null,
    migrationCount: raw.has('migration-count') ? Number(raw.get('migration-count')) : null,
    gates,
  };
}
