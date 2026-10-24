-- Last N outputs of one LLM dynasty on one pipe (MODEL-OUTPUTS-1024-CG): one index walk per model
-- version, newest first, never a scan of the table.
CREATE INDEX IF NOT EXISTS "idx_emailgen_model_created" ON "email_generations" ("model", "created_at");
