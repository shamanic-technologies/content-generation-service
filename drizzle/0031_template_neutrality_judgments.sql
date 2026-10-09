CREATE TABLE IF NOT EXISTS "template_neutrality_judgments" (
	"content_key" text PRIMARY KEY NOT NULL,
	"rule_version" text NOT NULL,
	"neutral" boolean NOT NULL,
	"passages" jsonb NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"org_id" uuid,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
