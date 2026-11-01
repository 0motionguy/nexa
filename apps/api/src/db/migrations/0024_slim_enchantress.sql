ALTER TABLE "nb_market_positions" ALTER COLUMN "status" SET DATA TYPE varchar(20);--> statement-breakpoint
ALTER TABLE "nb_market_positions" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "lifecycle_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "avg_fill_price_usd" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "filled_qty_usd" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "filled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nb_market_positions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;