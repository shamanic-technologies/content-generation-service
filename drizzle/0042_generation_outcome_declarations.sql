-- COST-ACCOUNTING-1023-P1: the outcome declaration of each message written, sent to runs-service.
-- `outcomes` = the exact body POSTed to /v1/runs/{generation_run_id}/outcomes (stored in the same
-- insert as the generation, so it is never lost); `outcomes_declared_at` once runs-service accepted
-- it; `outcomes_error` when it refused it for good. Rows written before this carry NULL and are
-- never declared (their completion did not run under the generation's own run).
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "outcomes" jsonb;
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "outcomes_declared_at" timestamp with time zone;
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "outcomes_error" text;
ALTER TABLE IF EXISTS "whatsapp_generations" ADD COLUMN IF NOT EXISTS "generation_run_id" text;
ALTER TABLE IF EXISTS "whatsapp_generations" ADD COLUMN IF NOT EXISTS "outcomes" jsonb;
ALTER TABLE IF EXISTS "whatsapp_generations" ADD COLUMN IF NOT EXISTS "outcomes_declared_at" timestamp with time zone;
ALTER TABLE IF EXISTS "whatsapp_generations" ADD COLUMN IF NOT EXISTS "outcomes_error" text;
CREATE INDEX IF NOT EXISTS "idx_emailgen_outcomes_pending" ON "email_generations" ("created_at")
  WHERE "outcomes" IS NOT NULL AND "outcomes_declared_at" IS NULL AND "outcomes_error" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_wagen_outcomes_pending" ON "whatsapp_generations" ("created_at")
  WHERE "outcomes" IS NOT NULL AND "outcomes_declared_at" IS NULL AND "outcomes_error" IS NULL;
