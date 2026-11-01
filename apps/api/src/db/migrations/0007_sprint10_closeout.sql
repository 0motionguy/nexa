CREATE TABLE "nb_bridge_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payout_method_id" uuid NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_campaign_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"clip_url" text NOT NULL,
	"platform" varchar(12) NOT NULL,
	"views_attested" integer DEFAULT 0 NOT NULL,
	"views_verified" integer DEFAULT 0 NOT NULL,
	"status" varchar(12) DEFAULT 'submitted' NOT NULL,
	"paid_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brand" text NOT NULL,
	"base_usd" numeric(18, 6) NOT NULL,
	"bonus_tiers" jsonb NOT NULL,
	"top_prize_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"status" varchar(8) DEFAULT 'active' NOT NULL,
	"end_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_market_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"venue" varchar(16) NOT NULL,
	"symbol" text NOT NULL,
	"side_long" boolean NOT NULL,
	"qty_usd" numeric(18, 6) NOT NULL,
	"entry_price_usd" numeric(18, 6) NOT NULL,
	"status" varchar(8) DEFAULT 'open' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_payout_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(8) NOT NULL,
	"external_account_id" text NOT NULL,
	"label" text NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_user_perks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"tier" varchar(12) DEFAULT 'starter' NOT NULL,
	"lifetime_earned_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_user_state" ADD COLUMN "earn_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_user_state" ADD COLUMN "auto_divest_on_spend" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_user_state" ADD COLUMN "divest_threshold_usd" numeric(18, 6) DEFAULT '50' NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_bridge_transfers" ADD CONSTRAINT "nb_bridge_transfers_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_bridge_transfers" ADD CONSTRAINT "nb_bridge_transfers_payout_method_id_nb_payout_methods_id_fk" FOREIGN KEY ("payout_method_id") REFERENCES "public"."nb_payout_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_campaign_submissions" ADD CONSTRAINT "nb_campaign_submissions_campaign_id_nb_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."nb_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_campaign_submissions" ADD CONSTRAINT "nb_campaign_submissions_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_campaigns" ADD CONSTRAINT "nb_campaigns_creator_id_nb_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD CONSTRAINT "nb_market_positions_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_payout_methods" ADD CONSTRAINT "nb_payout_methods_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_user_perks" ADD CONSTRAINT "nb_user_perks_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nb_campaign_submissions_campaign_user_uq" ON "nb_campaign_submissions" USING btree ("campaign_id","user_id");