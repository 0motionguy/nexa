-- Stack upgrades Phase 0: schema gate.
--
-- 1) nb_user_state.preferred_vault_tier  — Upgrade 1 (earn router selects
--    'standard' vs 'higher_yield' adapter from a per-user pref).
-- 2) nb_privy_wallets is reshaped to (id, agent_id PK-cascade, wallet_id,
--    address, chain) + unique(agent_id, chain). The pre-existing table was
--    unused at the store layer (Sprint 6 stub) so a drop+recreate is safe.
-- 3) nb_stripe_sessions               — Upgrade 4 (Stripe Checkout correlation).
-- 4) nb_agent_spend_digests           — Upgrade 3 (daily Resend digest idempotency).

ALTER TABLE "nb_user_state" ADD COLUMN "preferred_vault_tier" varchar(16) DEFAULT 'standard' NOT NULL;--> statement-breakpoint

DROP TABLE "nb_privy_wallets" CASCADE;--> statement-breakpoint
CREATE TABLE "nb_privy_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"wallet_id" varchar(120) NOT NULL,
	"address" varchar(64) NOT NULL,
	"chain" varchar(16) DEFAULT 'base' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_privy_wallets" ADD CONSTRAINT "nb_privy_wallets_agent_id_nb_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nb_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nb_privy_wallets_agent_chain_uq" ON "nb_privy_wallets" USING btree ("agent_id","chain");--> statement-breakpoint

CREATE TABLE "nb_stripe_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar(120) NOT NULL,
	"offer_id" uuid NOT NULL,
	"buyer_email" varchar(120) NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "nb_stripe_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "nb_stripe_sessions" ADD CONSTRAINT "nb_stripe_sessions_offer_id_nb_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."nb_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "nb_agent_spend_digests" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_window_spent_usd" numeric(18, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_agent_spend_digests" ADD CONSTRAINT "nb_agent_spend_digests_agent_id_nb_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nb_agents"("id") ON DELETE cascade ON UPDATE no action;
