ALTER TABLE "email_generations" ADD COLUMN "lead_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_emailgen_lead" ON "email_generations" USING btree ("campaign_id","lead_id");