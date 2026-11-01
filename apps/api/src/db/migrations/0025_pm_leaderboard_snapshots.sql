CREATE TABLE "nb_pm_leaderboard_snapshots" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"sort" varchar(16) NOT NULL,
	"trader_limit" integer NOT NULL,
	"market_limit" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nb_pm_leaderboard_snapshots_expires_idx" ON "nb_pm_leaderboard_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "nb_pm_leaderboard_snapshots_params_idx" ON "nb_pm_leaderboard_snapshots" USING btree ("sort","trader_limit","market_limit");