CREATE TABLE IF NOT EXISTS "feature_prompt_assignment" (
	"feature_slug" text PRIMARY KEY NOT NULL,
	"prompt_type" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
