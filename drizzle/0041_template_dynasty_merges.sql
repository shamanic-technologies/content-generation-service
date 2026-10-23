-- MERGE-TEMPLATE-DYNASTY-1023: staff fold one template dynasty into a sibling of the same pipe and identity.
-- The merged dynasty's row stays (its slug resolves to the target), marked with who merged it, when and why.
ALTER TABLE IF EXISTS "template_dynasties" ADD COLUMN IF NOT EXISTS "merged_into" text REFERENCES "template_dynasties"("slug");--> statement-breakpoint
ALTER TABLE IF EXISTS "template_dynasties" ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE IF EXISTS "template_dynasties" ADD COLUMN IF NOT EXISTS "merged_by" text;--> statement-breakpoint
ALTER TABLE IF EXISTS "template_dynasties" ADD COLUMN IF NOT EXISTS "merge_reason" text;
