-- Replace dual partial indexes with a single unique index on type.
-- type is now the unique identifier for a prompt (no org scoping on visibility).

DROP INDEX IF EXISTS "idx_prompts_org_type";
DROP INDEX IF EXISTS "idx_prompts_platform_type";

CREATE UNIQUE INDEX "idx_prompts_type" ON "prompts" ("type");
