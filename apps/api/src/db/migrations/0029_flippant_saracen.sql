CREATE TABLE "nb_expo_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" varchar(16) NOT NULL,
	"app_version" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_expo_push_subscriptions" ADD CONSTRAINT "nb_expo_push_subscriptions_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nb_expo_push_subscriptions_user_token_uq" ON "nb_expo_push_subscriptions" USING btree ("user_id","token");--> statement-breakpoint
CREATE INDEX "nb_expo_push_subscriptions_user_idx" ON "nb_expo_push_subscriptions" USING btree ("user_id");