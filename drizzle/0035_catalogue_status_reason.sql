-- Every deprecation states WHY and WHO (DEPRECATION-REASON-1020). Rows deprecated before
-- this keep NULL in both: reads serve the reason "Not specified" and no author, never invented.
ALTER TABLE IF EXISTS "prompts" ADD COLUMN IF NOT EXISTS "status_reason" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "prompts" ADD COLUMN IF NOT EXISTS "status_changed_by" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "model_statuses" ADD COLUMN IF NOT EXISTS "status_reason" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "model_statuses" ADD COLUMN IF NOT EXISTS "status_changed_by" text;
