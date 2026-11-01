CREATE TABLE "nb_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"prefix" varchar(8) NOT NULL,
	"key_hash" varchar(80) NOT NULL,
	"last4" varchar(8) NOT NULL,
	"label" varchar(80),
	"livemode" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "nb_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "nb_offers" ADD COLUMN "livemode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_payments" ADD COLUMN "livemode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_user_state" ADD COLUMN "sandbox_bal_usd" numeric(18, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_api_keys" ADD CONSTRAINT "nb_api_keys_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;