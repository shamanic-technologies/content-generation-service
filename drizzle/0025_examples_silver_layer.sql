-- Medallion (bronze → silver → gold) for workflow example emails.
--   Bronze: email_generations (raw, append-only generation log).
--   Silver: email_examples_silver (this file) — content-bearing, conformed example projection.
--   Gold:   derive-on-read cascade in src/lib/examples-query.ts (NOT materialized).
-- Layering is logical (one index + one view), per Databricks/Lakshmanan/Baeyens: minimize
-- copies, gold derive-on-read, materialize only on perf need. See "Data layering" in CLAUDE.md.

-- All cascade tiers filter on workflow_slug; the global tier scans cross-org, so index it.
CREATE INDEX IF NOT EXISTS "idx_emailgen_workflow" ON "email_generations" ("workflow_slug");

-- Silver layer: cleansed (drop content-less / failed generations) + conformed (stable example
-- column set) projection over the bronze log. Plain VIEW = zero new state, rebuildable from bronze.
CREATE OR REPLACE VIEW "email_examples_silver" AS
SELECT
  id,
  org_id,
  brand_ids,
  workflow_slug,
  created_at,
  subject,
  body_html,
  body_text,
  sequence,
  lead_first_name,
  lead_last_name,
  lead_company,
  lead_title,
  lead_industry,
  client_company_name
FROM email_generations
WHERE
  (subject IS NOT NULL AND subject <> '')
  OR (body_html IS NOT NULL AND body_html <> '')
  OR (body_text IS NOT NULL AND body_text <> '')
  OR (jsonb_typeof(sequence) = 'array' AND jsonb_array_length(sequence) > 0);
