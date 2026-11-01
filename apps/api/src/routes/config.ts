import { Hono } from 'hono';
import { safeModeSnapshot } from '../lib/safe-mode.js';

export const configRoutes = new Hono();

configRoutes.get('/safe-mode', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(safeModeSnapshot());
});
