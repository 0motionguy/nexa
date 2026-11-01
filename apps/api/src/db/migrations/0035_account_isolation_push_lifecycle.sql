CREATE TABLE "nb_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"jti" varchar(64) NOT NULL,
	"installation_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "nb_sessions_jti_unique" UNIQUE("jti")
);
--> statement-breakpoint
ALTER TABLE "nb_sessions" ADD CONSTRAINT "nb_sessions_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nb_sessions_user_idx" ON "nb_sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "nb_expo_push_subscriptions" ADD COLUMN "installation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "nb_expo_push_subscriptions" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nb_expo_push_subscriptions" ADD COLUMN "preferences" jsonb;--> statement-breakpoint
UPDATE "nb_expo_push_subscriptions" SET "installation_id" = 'legacy-' || left(md5("token"), 16) WHERE "installation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "nb_expo_push_subscriptions" ALTER COLUMN "installation_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "nb_expo_push_subscriptions_user_token_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "nb_expo_push_subscriptions_user_installation_uq" ON "nb_expo_push_subscriptions" USING btree ("user_id","installation_id");--> statement-breakpoint
CREATE INDEX "nb_expo_push_subscriptions_user_token_idx" ON "nb_expo_push_subscriptions" USING btree ("user_id","token");
