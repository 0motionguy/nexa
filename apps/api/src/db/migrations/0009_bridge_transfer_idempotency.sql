ALTER TABLE "nb_bridge_transfers" ADD COLUMN "idempotency_key" varchar(120);--> statement-breakpoint
CREATE UNIQUE INDEX "nb_bridge_transfers_external_ref_uq" ON "nb_bridge_transfers" USING btree ("external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "nb_bridge_transfers_user_idempotency_key_uq" ON "nb_bridge_transfers" USING btree ("user_id","idempotency_key");