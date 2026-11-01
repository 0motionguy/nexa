CREATE TABLE "nb_chain_cursors" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
