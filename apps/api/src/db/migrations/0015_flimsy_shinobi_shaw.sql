ALTER TABLE "nb_users" ADD COLUMN "privy_wallet_id" varchar(80);--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "privy_wallet_address" varchar(42);--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "hl_builder_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "hl_builder_max_fee_tenths_bp" integer;