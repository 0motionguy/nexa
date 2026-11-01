CREATE TABLE "nb_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_push_subscriptions" ADD CONSTRAINT "nb_push_subscriptions_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nb_push_subscriptions_user_endpoint_uq" ON "nb_push_subscriptions" USING btree ("user_id","endpoint");--> statement-breakpoint
CREATE INDEX "nb_push_subscriptions_user_idx" ON "nb_push_subscriptions" USING btree ("user_id");