CREATE TABLE "nb_cc_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"side" varchar(8) NOT NULL,
	"nft_address" varchar(64) NOT NULL,
	"card_id" varchar(64),
	"name" text,
	"image_url" text,
	"price_usdc" numeric(18, 6) NOT NULL,
	"fee_usdc" numeric(18, 6) DEFAULT '0' NOT NULL,
	"token_standard" varchar(8),
	"signature" varchar(100),
	"status" varchar(16) DEFAULT 'submitted' NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_cc_trades" ADD CONSTRAINT "nb_cc_trades_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nb_cc_trades_user_created_idx" ON "nb_cc_trades" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "nb_cc_trades_signature_uq" ON "nb_cc_trades" USING btree ("signature");