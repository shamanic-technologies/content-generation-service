-- MODEL-RUN-COST-1024-CG: the runs-service run(s) of the chat-service completion that WROTE each
-- generation, matched from the run tree (src/lib/completion-runs.ts), or why it cannot be told.
-- Both NULL = not matched yet: GET /internal/sequences holds the entry back until it is.
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "completion_run_ids" text[];
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "completion_runs_reason" text;
ALTER TABLE IF EXISTS "whatsapp_generations" ADD COLUMN IF NOT EXISTS "completion_run_ids" text[];
ALTER TABLE IF EXISTS "whatsapp_generations" ADD COLUMN IF NOT EXISTS "completion_runs_reason" text;
CREATE INDEX IF NOT EXISTS "idx_emailgen_completion_pending" ON "email_generations" ("created_at")
  WHERE "completion_run_ids" IS NULL AND "completion_runs_reason" IS NULL AND "lead_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_wagen_completion_pending" ON "whatsapp_generations" ("created_at")
  WHERE "completion_run_ids" IS NULL AND "completion_runs_reason" IS NULL AND "lead_id" IS NOT NULL;
