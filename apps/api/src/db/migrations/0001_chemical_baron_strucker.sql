CREATE TABLE "nb_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"image_url" text,
	"amount_usd" numeric(18, 6) NOT NULL,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"type" varchar(16) DEFAULT 'one_time' NOT NULL,
	"fulfillment_kind" varchar(12) DEFAULT 'none' NOT NULL,
	"fulfillment_value" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"offer_title" text NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"currency" varchar(8) NOT NULL,
	"buyer_email" varchar(320),
	"method" varchar(16) DEFAULT 'demo' NOT NULL,
	"status" varchar(12) DEFAULT 'paid' NOT NULL,
	"fulfillment_sent" boolean DEFAULT false NOT NULL,
	"idempotency_key" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nb_payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "nb_webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" varchar(80) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_offers" ADD CONSTRAINT "nb_offers_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_payments" ADD CONSTRAINT "nb_payments_offer_id_nb_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."nb_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_payments" ADD CONSTRAINT "nb_payments_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_webhook_endpoints" ADD CONSTRAINT "nb_webhook_endpoints_seller_id_nb_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;