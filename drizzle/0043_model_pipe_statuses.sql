-- A writer model's staff status is stated PER PIPE (LLM-STATUS-PER-PIPE-1023, owner 2026-10-23:
-- "Il faut que la deprecation manuelle soit par pipe"). A pipe = (feature_slug, leg_key), the
-- identity template dynasties use. No row for (model, pipe) = active on that pipe.
CREATE TABLE IF NOT EXISTS "model_pipe_statuses" (
  "model" text NOT NULL,
  "feature_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "status" text NOT NULL,
  "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status_reason" text,
  "status_changed_by" text,
  CONSTRAINT "model_pipe_statuses_pk" PRIMARY KEY ("model", "feature_slug", "leg_key")
);
--> statement-breakpoint
-- The only global deprecations ever stored (opus, glm-pro, 2026-10-23 06:40, "Too expensive, too
-- smart for clicks") were meant for Cold Email Lead -> Website visit only: they move there, reason,
-- author and date kept. Nothing else was ever deprecated globally.
INSERT INTO "model_pipe_statuses" ("model", "feature_slug", "leg_key", "status", "status_changed_at", "status_reason", "status_changed_by")
SELECT "model", 'sales-cold-email-outreach', 'lead_found_to_website_visit', "status", "status_changed_at", "status_reason", "status_changed_by"
FROM "model_statuses"
WHERE "status" = 'deprecated'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- No global model status any more: a per-pipe action can never retire a model everywhere.
DROP TABLE IF EXISTS "model_statuses";
