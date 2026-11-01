/**
 * W2-B — REDIS_URL parser. The whole point of the module is that malformed
 * input returns null (so callers can fail closed) instead of coercing to a
 * default that lands counters/queues in the wrong keyspace.
 */

import { describe, expect, it } from 'vitest';
import { parseRedisUrl } from './redis-url.js';

describe('parseRedisUrl — happy paths', () => {
  it('parses a bare host with defaults (port 6379, db 0, no auth)', () => {
    expect(parseRedisUrl('redis://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 0,
    });
  });

  it('parses the production compose shape: password-only auth + logical db', () => {
    // Mirrors infra/compose-fragment.yml: redis://:${REDIS_PASSWORD}@redis:6379/2
    expect(parseRedisUrl('redis://:s3cret@redis:6379/2')).toEqual({
      host: 'redis',
      port: 6379,
      password: 's3cret',
      db: 2,
    });
  });

  it('percent-decodes passwords (special chars survive the URL round-trip)', () => {
    const parsed = parseRedisUrl('redis://:p%40ss%2Fword@h:6380/1');
    expect(parsed).toMatchObject({ host: 'h', port: 6380, password: 'p@ss/word', db: 1 });
  });

  it('keeps ACL usernames instead of silently AUTHing as default', () => {
    expect(parseRedisUrl('redis://limiter:pw@h')).toMatchObject({
      username: 'limiter',
      password: 'pw',
    });
  });

  it('rediss:// sets the TLS flag', () => {
    expect(parseRedisUrl('rediss://h:6380')).toEqual({
      host: 'h',
      port: 6380,
      db: 0,
      tls: {},
    });
    // Plain redis:// must NOT carry tls.
    expect(parseRedisUrl('redis://h')).not.toHaveProperty('tls');
  });

  it('ignores query params (?family=6 style tuning is not our concern)', () => {
    expect(parseRedisUrl('redis://h:6379/0?family=6')).toMatchObject({ host: 'h', db: 0 });
  });
});

describe('parseRedisUrl — fail-closed on malformed input', () => {
  it('returns null for undefined/empty', () => {
    expect(parseRedisUrl(undefined)).toBeNull();
    expect(parseRedisUrl('')).toBeNull();
  });

  it('returns null for non-redis protocols', () => {
    expect(parseRedisUrl('http://h:6379')).toBeNull();
    expect(parseRedisUrl('postgresql://u:p@h/db')).toBeNull();
  });

  it('returns null for unparseable garbage', () => {
    expect(parseRedisUrl('not a url at all')).toBeNull();
  });

  it('returns null for a non-numeric logical db (the pre-W2-B `|| 0` trap)', () => {
    expect(parseRedisUrl('redis://h:6379/2x')).toBeNull();
    expect(parseRedisUrl('redis://h/nope')).toBeNull();
  });

  it('returns null for out-of-range ports', () => {
    expect(parseRedisUrl('redis://h:70000')).toBeNull();
  });

  it('returns null when the host is missing', () => {
    expect(parseRedisUrl('redis:///2')).toBeNull();
  });
});
