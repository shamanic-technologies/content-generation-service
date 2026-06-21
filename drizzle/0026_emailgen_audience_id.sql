ALTER TABLE "email_generations" ADD COLUMN IF NOT EXISTS "audience_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_emailgen_audience" ON "email_generations" ("audience_id");
