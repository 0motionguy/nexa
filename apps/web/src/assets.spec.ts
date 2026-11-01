import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const integrationsDir = resolve(process.cwd(), 'public/integrations');

describe('public integration assets', () => {
  it('keeps .svg files as static SVG documents', async () => {
    const files = (await readdir(integrationsDir)).filter((file) => file.endsWith('.svg'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const raw = await readFile(join(integrationsDir, file), 'utf8');
      const body = raw
        .trimStart()
        .replace(/^<\?xml[^>]*>\s*/i, '')
        .replace(/^(<!--[\s\S]*?-->\s*)*/i, '');
      expect(body.slice(0, 128), file).toMatch(/^<svg[\s>]/i);
      expect(raw, file).not.toMatch(/<script\b|on[a-z]+\s*=|javascript:/i);
    }
  });
});
