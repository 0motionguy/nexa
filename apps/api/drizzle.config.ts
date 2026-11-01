import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://toolbox:toolbox@localhost:5432/toolbox',
  },
  tablesFilter: ['nb_*'],
  verbose: true,
  strict: true,
});
