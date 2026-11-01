import { env } from './env.js';
import { store } from '../store/index.js';
import type { User } from '../store/types.js';

function parseEntry(entry: string): { key: string; email?: string } | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const [key, email] = trimmed.split('=', 2).map((part) => part.trim());
  if (!key) return null;
  return email ? { key, email } : { key };
}

export async function userForAgentKey(provided: string): Promise<User | null> {
  for (const raw of env.NEXA_AGENT_KEYS.split(',')) {
    const entry = parseEntry(raw);
    if (!entry || entry.key !== provided) continue;
    if (entry.email) {
      const user = await store.upsertUserByEmail(entry.email);
      await store.bindAgentKeyToUser(entry.key, user.id);
      return user;
    }
    return store.userForAgentKey(entry.key);
  }
  return null;
}
