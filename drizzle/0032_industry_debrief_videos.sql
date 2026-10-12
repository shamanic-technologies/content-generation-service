CREATE TABLE IF NOT EXISTS "industry_debrief_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"parent_run_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tracking" jsonb NOT NULL,
	"idempotency_key" text,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"video_url" text,
	"duration_seconds" double precision,
	"music_track_id" integer,
	"error_code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_debrief_videos_idempotency" ON "industry_debrief_videos" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_debrief_videos_status" ON "industry_debrief_videos" ("status");
