CREATE TABLE IF NOT EXISTS "email_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"brand_name" text NOT NULL,
	"run_id" text NOT NULL,
	"recipient_key" text NOT NULL,
	"recipient" jsonb NOT NULL,
	"prompt_type" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"sequence" jsonb NOT NULL,
	"model" text NOT NULL,
	"tokens_input" integer,
	"tokens_output" integer,
	"prompt_raw" text,
	"response_raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_previews_recipient" ON "email_previews" USING btree ("org_id","brand_id","recipient_key");
