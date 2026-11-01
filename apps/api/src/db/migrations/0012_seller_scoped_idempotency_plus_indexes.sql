ALTER TABLE "nb_payments" DROP CONSTRAINT "nb_payments_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "nb_payouts" DROP CONSTRAINT "nb_payouts_idempotency_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "nb_payments_seller_idempotency_key_uq" ON "nb_payments" USING btree ("seller_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "nb_payments_seller_created_idx" ON "nb_payments" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nb_payouts_seller_idempotency_key_uq" ON "nb_payouts" USING btree ("seller_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "nb_payouts_seller_created_idx" ON "nb_payouts" USING btree ("seller_id","created_at");