-- Keyset index for GET /internal/sequences (src/lib/sequence-feed-query.ts): a page is an
-- index range scan on (feature_slug, created_at, id), never a scan of the ~1 GB table.
CREATE INDEX IF NOT EXISTS "idx_emailgen_feature_created" ON "email_generations" ("feature_slug", "created_at", "id");
