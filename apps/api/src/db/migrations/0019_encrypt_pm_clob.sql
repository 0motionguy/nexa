-- SEC-01 (Sprint 17.5 / 2026-06-19) — widen Polymarket CLOB credential
-- columns so the AES-256-GCM envelope (`nx1:<iv>:<authTag>:<ciphertext>`)
-- fits. Existing plaintext rows continue to read fine — lib/crypto.ts
-- `decryptIfWrapped` passes legacy values through unchanged.
--
-- Backfill (encrypt-in-place for existing rows) happens at first write
-- per user; PM CLOB creds are derive-on-demand and very low cardinality,
-- so we let the next `setPmClobCredentials({force:true})` carry the
-- rotation. No row-by-row script needed.

ALTER TABLE "nb_users" ALTER COLUMN "pm_clob_key" TYPE varchar(400);--> statement-breakpoint
ALTER TABLE "nb_users" ALTER COLUMN "pm_clob_secret" TYPE varchar(400);--> statement-breakpoint
ALTER TABLE "nb_users" ALTER COLUMN "pm_clob_passphrase" TYPE varchar(400);
