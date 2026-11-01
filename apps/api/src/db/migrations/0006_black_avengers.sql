ALTER TABLE "nb_claim_wallets" ADD COLUMN "slug" varchar(24);--> statement-breakpoint
ALTER TABLE "nb_claim_wallets" ADD COLUMN "status" varchar(12) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_claim_wallets" ADD COLUMN "sender_name" varchar(120);--> statement-breakpoint
ALTER TABLE "nb_claim_wallets" ADD CONSTRAINT "nb_claim_wallets_slug_unique" UNIQUE("slug");