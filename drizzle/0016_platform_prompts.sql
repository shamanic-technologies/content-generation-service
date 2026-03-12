-- Make org_id nullable to support platform-wide prompts (org_id = NULL)
ALTER TABLE "prompts" ALTER COLUMN "org_id" DROP NOT NULL;

-- Replace the old unique index with two partial indexes
DROP INDEX IF EXISTS "idx_prompts_org_type";

-- Org-specific prompts: one per (org, type)
CREATE UNIQUE INDEX "idx_prompts_org_type" ON "prompts" ("org_id", "type") WHERE org_id IS NOT NULL;

-- Platform prompts: one per type
CREATE UNIQUE INDEX "idx_prompts_platform_type" ON "prompts" ("type") WHERE org_id IS NULL;
