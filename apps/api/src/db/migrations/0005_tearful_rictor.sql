CREATE TABLE "nb_virtual_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" varchar(8) NOT NULL,
	"routing_number" varchar(40),
	"account_number" varchar(60),
	"iban" varchar(60),
	"bic" varchar(20),
	"bank_name" varchar(80) NOT NULL,
	"livemode" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nb_users" ADD COLUMN "bridge_customer_id" varchar(80);--> statement-breakpoint
ALTER TABLE "nb_virtual_accounts" ADD CONSTRAINT "nb_virtual_accounts_user_id_nb_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."nb_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nb_users" ADD CONSTRAINT "nb_users_bridge_customer_id_unique" UNIQUE("bridge_customer_id");