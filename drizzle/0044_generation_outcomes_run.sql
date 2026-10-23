-- COST-BACKFILL-1023-CONTENTGEN: the run an email's outcome declaration was made ON, when it is
-- not the generation's own run. Before COST-ACCOUNTING-1023-P1 the completion that wrote the email
-- ran under the CALLER's run (chat-service `complete`, a sibling of our run), so the backfill
-- declares the email on that completion run: the run that paid for it. NULL = generation_run_id.
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "outcomes_run_id" text;
