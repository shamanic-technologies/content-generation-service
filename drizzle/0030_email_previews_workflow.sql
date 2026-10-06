ALTER TABLE IF EXISTS "email_previews" ADD COLUMN IF NOT EXISTS "workflow_slug" text;--> statement-breakpoint
ALTER TABLE IF EXISTS "email_previews" ADD COLUMN IF NOT EXISTS "model_alias" text;
