CREATE TABLE "nb_hl_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_wallet_address" varchar(42) NOT NULL,
	"agent_address" varchar(42) NOT NULL,
	"agent_name" varchar(32),
	"process_id" varchar(80),
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nb_hl_agents_wallet_idx" ON "nb_hl_agents" USING btree ("user_wallet_address");