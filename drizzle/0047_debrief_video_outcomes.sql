-- LEDGER-HISTORY-1024: a delivered industry debrief video PRODUCES `industry_update_video` on its
-- render run (src/lib/outcome-declarations.ts). Both NULL on a done render = not declared yet: the
-- sweep sends it, past renders included (dated finished_at).
ALTER TABLE IF EXISTS "industry_debrief_videos" ADD COLUMN IF NOT EXISTS "outcomes_declared_at" timestamp with time zone;
ALTER TABLE IF EXISTS "industry_debrief_videos" ADD COLUMN IF NOT EXISTS "outcomes_error" text;
