-- Readiness audit 2026-07-16 — positions-history hot path.
-- routes/markets.ts lists a user's positions ordered by recency. Same shape
-- 0036 indexed for nb_transactions (user_id, created_at DESC). Drizzle runs
-- pending PostgreSQL migrations in one transaction, so CONCURRENTLY is not
-- legal here. Fail fast if a live writer prevents lock acquisition, and cap
-- the blocking build itself; reset both settings so later migrations in the
-- same transaction inherit the deployment defaults.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE INDEX "nb_market_positions_user_created_idx" ON "nb_market_positions" USING btree ("user_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
