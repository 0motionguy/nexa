import {
  SafeModeResponse,
  SafeModeSubsystem as SafeModeSubsystemSchema,
  type SafeModeSubsystem,
} from '@nexa/shared-zod';
import { env, features } from './env.js';

export function safeModeSnapshot(): SafeModeResponse {
  const requested = new Set(
    env.SAFE_MODE_DISABLED.split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const disabled = SafeModeSubsystemSchema.options.filter(
    (name) =>
      requested.has(name) ||
      (name === 'realtimeHub' && !env.REALTIME_HUB_V1) ||
      (name === 'venueLiveTrading' && !features.markets),
  );
  return SafeModeResponse.parse({ v: 1, disabled });
}

export function isSafeModeDisabled(name: SafeModeSubsystem): boolean {
  return safeModeSnapshot().disabled.includes(name);
}
