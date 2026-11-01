import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('insights mini app wiring', () => {
  it('turns the spend tile into an Insights screen backed by monthly spend', () => {
    const html = readFileSync(resolve(process.cwd(), 'app.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const api = readFileSync(resolve(process.cwd(), 'src/lib/api.ts'), 'utf8');

    expect(html).toContain('id="spendInsightCard"');
    expect(html).toContain('data-go="s34"');
    expect(html).toContain('id="s34"');
    expect(html).toContain('id="insightsCategoryList"');
    expect(html).toContain('id="insightsExportCsv"');
    expect(api).toContain("spendMonthly: () => api<SpendMonthlyResponse>('/spend/monthly')");
    expect(app).toContain('function renderInsights()');
    expect(app).toContain('async function syncInsights()');
  });
});
