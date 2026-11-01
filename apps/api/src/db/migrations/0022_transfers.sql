CREATE TABLE "nb_transfer_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transfer_id" varchar(40) NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_transfers" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"from_bucket" varchar(16) NOT NULL,
	"to_bucket" varchar(16) NOT NULL,
	"from_chain" varchar(16) NOT NULL,
	"to_chain" varchar(16) NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"amount_token_atoms" text NOT NULL,
	"token" varchar(12) DEFAULT 'USDC' NOT NULL,
	"rail" varchar(16) NOT NULL,
	"status" varchar(20) DEFAULT 'created' NOT NULL,
	"src_tx_hash" varchar(80),
	"dst_tx_hash" varchar(80),
	"src_call_id" varchar(80),
	"dst_call_id" varchar(80),
	"cctp_message_hash" varchar(80),
	"cctp_message_body" text,
	"cctp_attestation" text,
	"fees_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"error" jsonb,
	"idempotency_key" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_transfer_events" ADD CONSTRAINT "nb_transfer_events_transfer_id_nb_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."nb_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_transfers" ADD CONSTRAINT "nb_transfers_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nb_transfer_events_transfer_created_idx" ON "nb_transfer_events" USING btree ("transfer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nb_transfers_user_idempotency_key_uq" ON "nb_transfers" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "nb_transfers_user_created_idx" ON "nb_transfers" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nb_transfers_status_idx" ON "nb_transfers" USING btree ("status");