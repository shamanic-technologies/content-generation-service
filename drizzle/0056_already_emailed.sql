-- COLD-COPY-RESEND-1126: a request stating the person already holds our email writes a NEW email and stores it
-- as an extra row for the same (campaign, lead). The first-touch row stays unique per (campaign, lead).
-- ADD COLUMN with a constant default is metadata-only (PG 11+). The index rebuild covers ~90k rows (~1 s).
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "already_emailed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_emailgen_lead";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_emailgen_lead" ON "email_generations" ("campaign_id", "lead_id") WHERE already_emailed = false;
