-- Last N outputs of one workflow dynasty, newest first (WF-RUNS-OUTPUTS-1022): an index range scan per version slug.
CREATE INDEX IF NOT EXISTS "idx_emailgen_workflow_created" ON "email_generations" ("workflow_slug", "created_at");
