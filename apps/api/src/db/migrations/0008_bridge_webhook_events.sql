CREATE TABLE "nb_bridge_webhook_events" (
	"ref" varchar(160) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" varchar(80) NOT NULL,
	"amount_usd" numeric(18, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_bridge_webhook_events" ADD CONSTRAINT "nb_bridge_webhook_events_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;
