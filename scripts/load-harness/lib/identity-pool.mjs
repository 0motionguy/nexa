/**
 * lib/identity-pool.mjs — the fix for audit blocker #11's core defect:
 * load-gate.mjs simulates fleet load with ONE authenticated token fanned
 * out across many connections. Certification requires N DISTINCT
 * authenticated users. This module refuses to start otherwise.
 */

import { readFileSync } from 'node:fs';

export class IdentityPoolError extends Error {}

/** Load newline-separated bearer tokens from --tokens-file. Blank lines
 * and lines starting with # are ignored (simple comment support for
 * hand-maintained token files). */
export function loadTokenPool(tokensFilePath) {
  const raw = readFileSync(tokensFilePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Assign exactly one distinct token per requested user. Refuses to start
 * (throws IdentityPoolError) when the pool has fewer distinct tokens than
 * requested users — no one-token-simulates-many-VUs fallback exists here
 * by design; that silent substitution is precisely the defect this
 * harness replaces load-gate.mjs to fix.
 */
export function assignIdentities(tokens, userCount, rng = Math.random) {
  const distinct = [...new Set(tokens)];
  if (distinct.length < userCount) {
    throw new IdentityPoolError(
      `refuse to start: ${distinct.length} distinct token(s) in pool < ${userCount} requested users. ` +
      `Certification requires ${userCount} DISTINCT authenticated users, each owning one token for its ` +
      `lifetime — a single token fanned out across VUs is not a valid identity model for this gate ` +
      `(audit blocker #11 / docs/SCALE-PLAN-10K.md). Provision more tokens via --tokens-file.`
    );
  }
  const pool = [...distinct];
  // Fisher-Yates shuffle so "first N tokens" isn't always the same subset
  // across runs when a token file has more entries than requested users.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, userCount);
}
