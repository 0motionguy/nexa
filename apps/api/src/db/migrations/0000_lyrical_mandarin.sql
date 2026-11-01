CREATE TABLE "nb_agent_keys" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nb_agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"per_tx_cap_usd" numeric(18, 6) NOT NULL,
	"per_day_cap_usd" numeric(18, 6) NOT NULL,
	"endpoint_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_approval_threshold_usd" numeric(18, 6) NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid,
	"name" varchar(60) NOT NULL,
	"role" varchar(120),
	"state" varchar(20) DEFAULT 'ready' NOT NULL,
	"balance_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"spent_today_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_card_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"day_limit_usd" integer DEFAULT 500 NOT NULL,
	"gnosis_pay_token" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_claim_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"wallet_address" varchar(42) NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"code_hash" varchar(80) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_privy_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"privy_wallet_id" varchar(80) NOT NULL,
	"address" varchar(42) NOT NULL,
	"chain" varchar(20) DEFAULT 'base' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'confirmed' NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"amount_usd" numeric(18, 6) NOT NULL,
	"counterparty" text,
	"tx_hash" varchar(80),
	"chain" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_user_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"bal_usd" numeric(18, 6) DEFAULT '4820.4' NOT NULL,
	"earn_usd" numeric(18, 6) DEFAULT '3200' NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(120),
	"privy_did" varchar(120),
	"kyc_status" varchar(20) DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nb_users_email_unique" UNIQUE("email"),
	CONSTRAINT "nb_users_privy_did_unique" UNIQUE("privy_did")
);
--> statement-breakpoint
CREATE TABLE "nb_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" varchar(42) NOT NULL,
	"kind" varchar(20) DEFAULT 'embedded' NOT NULL,
	"chain" varchar(20) DEFAULT 'base' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nb_wallets_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "nb_x402_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"endpoint_path" varchar(120) NOT NULL,
	"method" varchar(8) DEFAULT 'GET' NOT NULL,
	"price_usd" numeric(18, 6) NOT NULL,
	"currency" varchar(8) DEFAULT 'USDC' NOT NULL,
	"status" varchar(12) DEFAULT 'live' NOT NULL,
	"requests_today" integer DEFAULT 0 NOT NULL,
	"revenue_today_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nb_x402_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contract_id" uuid,
	"agent_id" uuid,
	"buyer" varchar(120) NOT NULL,
	"buyer_type" varchar(10) NOT NULL,
	"resource" text NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"http_status" integer NOT NULL,
	"settlement_ref" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_agent_keys" ADD CONSTRAINT "nb_agent_keys_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_agent_policies" ADD CONSTRAINT "nb_agent_policies_agent_id_nb_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nb_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_agents" ADD CONSTRAINT "nb_agents_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_agents" ADD CONSTRAINT "nb_agents_wallet_id_nb_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."nb_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_card_state" ADD CONSTRAINT "nb_card_state_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_claim_wallets" ADD CONSTRAINT "nb_claim_wallets_sender_user_id_nb_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_privy_wallets" ADD CONSTRAINT "nb_privy_wallets_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_privy_wallets" ADD CONSTRAINT "nb_privy_wallets_agent_id_nb_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nb_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_transactions" ADD CONSTRAINT "nb_transactions_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_transactions" ADD CONSTRAINT "nb_transactions_agent_id_nb_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nb_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_user_state" ADD CONSTRAINT "nb_user_state_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_wallets" ADD CONSTRAINT "nb_wallets_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_x402_contracts" ADD CONSTRAINT "nb_x402_contracts_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_x402_events" ADD CONSTRAINT "nb_x402_events_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_x402_events" ADD CONSTRAINT "nb_x402_events_contract_id_nb_x402_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."nb_x402_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_x402_events" ADD CONSTRAINT "nb_x402_events_agent_id_nb_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nb_agents"("id") ON DELETE no action ON UPDATE no action;