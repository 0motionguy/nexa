CREATE TABLE "nb_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_title" text NOT NULL,
	"buyer_email" varchar(320),
	"amount_usd" numeric(18, 6) NOT NULL,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"livemode" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_subscriptions" ADD CONSTRAINT "nb_subscriptions_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;