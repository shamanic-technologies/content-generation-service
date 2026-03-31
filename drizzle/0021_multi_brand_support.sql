-- Multi-brand support: migrate brand_id (text) to brand_ids (text[])
-- x-brand-id header now supports comma-separated UUIDs

ALTER TABLE "email_generations" ADD COLUMN "brand_ids" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint

UPDATE "email_generations" SET "brand_ids" = CASE
  WHEN "brand_id" IS NOT NULL AND "brand_id" != '' THEN ARRAY["brand_id"]
  ELSE '{}'
END;--> statement-breakpoint

ALTER TABLE "email_generations" DROP COLUMN "brand_id";--> statement-breakpoint

CREATE INDEX "idx_emailgen_brand_ids" ON "email_generations" USING GIN ("brand_ids");
