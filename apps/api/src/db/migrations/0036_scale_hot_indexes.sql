-- W2-C hot-query indexes. Plain CREATE INDEX is appropriate at current scale;
-- the production-rollout alternative for large/busy tables is CREATE INDEX
-- CONCURRENTLY (must run outside a transaction, one statement at a time).
CREATE INDEX "nb_agent_policies_agent_idx" ON "nb_agent_policies" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "nb_otp_challenges_expires_at_idx" ON "nb_otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "nb_subscriptions_status_period_idx" ON "nb_subscriptions" USING btree ("status","current_period_end");--> statement-breakpoint
CREATE INDEX "nb_transactions_user_created_idx" ON "nb_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nb_virtual_accounts_user_idx" ON "nb_virtual_accounts" USING btree ("user_id");