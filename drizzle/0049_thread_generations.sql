-- THREADS-IDEAS-AB: one row per Threads thread written with a stored template (POST /generate-thread).
-- run_id = the CALLER's run (the workflow run that publishes the thread): the completion is billed
-- under it and no outcome is declared here (the publisher declares post_published on that run).
CREATE TABLE IF NOT EXISTS "thread_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" text NOT NULL,
  "brand_ids" text[] NOT NULL,
  "campaign_id" text NOT NULL,
  "workflow_slug" text,
  "feature_slug" text,
  "prompt_type" text NOT NULL,
  "model" text NOT NULL,
  "subject" text NOT NULL,
  "post" text NOT NULL,
  "replies" jsonb NOT NULL,
  "tokens_input" integer,
  "tokens_output" integer,
  "system_prompt_raw" text,
  "context_raw" text,
  "variables_raw" jsonb,
  "response_raw" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threadgen_created" ON "thread_generations" ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threadgen_prompt_type_created" ON "thread_generations" ("prompt_type", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threadgen_model_created" ON "thread_generations" ("model", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_threadgen_run" ON "thread_generations" ("run_id");
