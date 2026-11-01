import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('JupiterAdapter confirmation handling', () => {
  it('does not treat failed confirmTransaction results as confirmed', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/markets/jupiter.ts'), 'utf8');

    expect(source).toContain('result.value.err == null');
    expect(source).not.toContain("confirmTransaction(signature, 'confirmed').then(() => 'confirmed' as const)");
  });
});
