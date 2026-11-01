import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('checkout balance preview', () => {
  it('does not disable the pay button solely from the local balance preview', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/checkout-main.ts'), 'utf8');

    expect(source).toContain("afterRow.classList.toggle('co-balance-short', short)");
    expect(source).toContain("$('#coLowBal').hidden = !short");
    expect(source).not.toMatch(/disabled\s*=\s*short\b/);
  });
});
