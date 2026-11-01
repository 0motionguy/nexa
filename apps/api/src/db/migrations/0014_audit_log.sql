CREATE TABLE "nb_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nb_audit_log_actor_idx" ON "nb_audit_log" USING btree ("actor_type","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nb_audit_log_action_idx" ON "nb_audit_log" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nb_audit_log_created_at_idx" ON "nb_audit_log" USING btree ("created_at" DESC NULLS LAST);