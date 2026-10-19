-- Staff catalogue status (TEMPLATE-MODEL-STATUS-1019): a template or a writer model is
-- `active` (default, every existing one) or `deprecated` (no NEW workflow may name it).
ALTER TABLE IF EXISTS "prompts" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE IF EXISTS "prompts" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_statuses" (
  "model" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Last N outputs of one template, newest first: an index range scan, never a scan of the table.
CREATE INDEX IF NOT EXISTS "idx_emailgen_prompt_type_created" ON "email_generations" ("prompt_type", "created_at");
