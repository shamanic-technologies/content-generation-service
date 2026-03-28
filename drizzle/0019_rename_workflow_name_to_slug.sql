ALTER TABLE "email_generations" RENAME COLUMN "workflow_name" TO "workflow_slug";--> statement-breakpoint
ALTER TABLE "content_generations" RENAME COLUMN "workflow_name" TO "workflow_slug";
