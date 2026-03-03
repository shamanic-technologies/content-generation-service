-- Remove FK constraints on org_id before dropping referenced tables
ALTER TABLE "email_generations" DROP CONSTRAINT IF EXISTS "email_generations_org_id_orgs_id_fk";
ALTER TABLE "content_generations" DROP CONSTRAINT IF EXISTS "content_generations_org_id_orgs_id_fk";

-- Remove appId columns
ALTER TABLE "email_generations" DROP COLUMN IF EXISTS "app_id";
ALTER TABLE "content_generations" DROP COLUMN IF EXISTS "app_id";

-- Remove keyMode column
ALTER TABLE "content_generations" DROP COLUMN IF EXISTS "key_mode";

-- Update prompts: replace app_id with org_id
DROP INDEX IF EXISTS "idx_prompts_app_type";
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "org_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE "prompts" DROP COLUMN IF EXISTS "app_id";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_prompts_org_type" ON "prompts" ("org_id", "type");

-- Remove appId-based indexes
DROP INDEX IF EXISTS "idx_contentgen_app";

-- Drop local identity tables (no longer needed — client-service is source of truth)
DROP TABLE IF EXISTS "users";
DROP TABLE IF EXISTS "orgs";
