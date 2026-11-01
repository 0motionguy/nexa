CREATE TABLE "nb_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"destination" varchar(320) NOT NULL,
	"method" varchar(16) DEFAULT 'email' NOT NULL,
	"note" text,
	"status" varchar(12) DEFAULT 'paid' NOT NULL,
	"livemode" boolean DEFAULT true NOT NULL,
	"idempotency_key" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nb_payouts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "nb_sub_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"bal_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"sandbox_bal_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_offers" ADD COLUMN "sub_account_id" uuid;--> statement-breakpoint
ALTER TABLE "nb_offers" ADD COLUMN "splits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_payouts" ADD CONSTRAINT "nb_payouts_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_sub_accounts" ADD CONSTRAINT "nb_sub_accounts_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;