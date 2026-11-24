-- REELS-1124: long video -> vertical clips with hooks. Four tables, all new; replayable from empty.
-- run_id is always the CALLER's run: this service opens no run and declares nothing for reels.
CREATE TABLE IF NOT EXISTS "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tracking" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"idempotency_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"error_code" text,
	"error" text,
	"source_file" text,
	"size_bytes" bigint,
	"duration_seconds" double precision,
	"width" integer,
	"height" integer,
	"has_audio" boolean,
	"transcript_status" text DEFAULT 'none' NOT NULL,
	"transcript_ref" text,
	"transcript_identity" jsonb,
	"transcript" jsonb,
	"transcript_language" text,
	"transcript_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"source_deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_videos_idempotency" ON "videos" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_status" ON "videos" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_transcript_status" ON "videos" ("transcript_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_org_source" ON "videos" ("org_id", "source_url");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tracking" jsonb NOT NULL,
	"video_id" uuid NOT NULL REFERENCES "videos"("id"),
	"parent_clip_id" uuid,
	"kind" text DEFAULT 'cut' NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"layout" text DEFAULT 'fit_blur' NOT NULL,
	"crop_x" double precision DEFAULT 0.5 NOT NULL,
	"captions" boolean DEFAULT true NOT NULL,
	"hook" jsonb,
	"idempotency_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"error_code" text,
	"error" text,
	"token" text NOT NULL,
	"file_name" text,
	"size_bytes" bigint,
	"duration_seconds" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"file_deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_video_clips_idempotency" ON "video_clips" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_clips_status" ON "video_clips" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_clips_video" ON "video_clips" ("video_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_llm_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"video_id" uuid NOT NULL,
	"clip_id" uuid,
	"kind" text NOT NULL,
	"model" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"request" jsonb,
	"response_raw" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_llm_proposals_video" ON "video_llm_proposals" ("video_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hook_library" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_url" text NOT NULL,
	"category" text,
	"template" text NOT NULL,
	"evidence" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hook_library_active" ON "hook_library" ("active", "source");
