ALTER TABLE "nb_users" ADD COLUMN "pm_clob_key" varchar(80);--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "pm_clob_secret" varchar(120);--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "pm_clob_passphrase" varchar(120);--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "privy_sol_wallet_id" varchar(80);--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "privy_sol_wallet_address" varchar(64);