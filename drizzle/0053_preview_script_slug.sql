ALTER TABLE IF EXISTS "email_previews" ADD COLUMN IF NOT EXISTS "script_slug" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "email_previews" ADD COLUMN IF NOT EXISTS "template_dynasty_slug" text;
