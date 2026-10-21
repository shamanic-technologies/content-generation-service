-- A template text belongs to ONE dynasty (TPL-DYNASTY-ONE-HOME-1021-CG, owner 2026-10-21: « une
-- dynastie partagée sur deux pipes ... c'est complètement interdit, et doit être interdit en dur »).
-- 21 texts sat in a cold-reply-* AND a cold-click-* dynasty (seed 0036 + 0037). Each stays in the
-- dynasty of the conversation pipe; the other dynasty gets its own copy at the same position: same
-- text and variables, status copied, new name `<family>-<pipe goal>-vN` (e.g. cold-email-v73 ->
-- cold-email-website-visit-v73), `copied_from` = the original, so a reader can still attribute that
-- pipe's past emails (written under the original name) to the dynasty holding the copy. No email
-- text changes for any workflow. Then exactly the heads are Active (bar a stated reason), and the database refuses a second
-- dynasty for a template. Replayable on an empty database (no versions there). A name collision
-- aborts the migration (plain INSERT): never map a version onto an unrelated template.
ALTER TABLE IF EXISTS "prompts" ADD COLUMN IF NOT EXISTS "copied_from" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tdv_0038" (dynasty_slug text, prompt_type text, new_type text);
--> statement-breakpoint
INSERT INTO "tdv_0038" (dynasty_slug, prompt_type, new_type)
SELECT r.dynasty_slug, r.prompt_type,
  CASE WHEN r.prompt_type ~ '^(.+)-v(\d+)(.*)$'
    THEN regexp_replace(r.prompt_type, '^(.+)-v(\d+)(.*)$', '\1-' || r.goal || '-v\2\3')
    ELSE r.prompt_type || '-' || r.goal END
FROM (
  SELECT v."dynasty_slug", v."prompt_type",
    replace(regexp_replace(d."leg_key", '^lead_found_to_', ''), '_', '-') AS goal,
    row_number() OVER (PARTITION BY v."prompt_type" ORDER BY (d."leg_key" = 'lead_found_to_conversation') DESC, v."dynasty_slug") AS rn
  FROM "template_dynasty_versions" v
  JOIN "template_dynasties" d ON d."slug" = v."dynasty_slug"
  WHERE v."prompt_type" IN (SELECT "prompt_type" FROM "template_dynasty_versions" GROUP BY 1 HAVING count(*) > 1)
) r
WHERE r.rn > 1;
--> statement-breakpoint
INSERT INTO "prompts" ("org_id", "type", "prompt", "variables", "status", "status_changed_at", "status_reason", "status_changed_by", "copied_from", "created_at", "updated_at")
SELECT p."org_id", m.new_type, p."prompt", p."variables", p."status", p."status_changed_at", p."status_reason", p."status_changed_by", p."type", p."created_at", now()
FROM "tdv_0038" m JOIN "prompts" p ON p."type" = m.prompt_type;
--> statement-breakpoint
UPDATE "template_dynasty_versions" v SET "prompt_type" = m.new_type
FROM "tdv_0038" m
WHERE v."dynasty_slug" = m.dynasty_slug AND v."prompt_type" = m.prompt_type;
--> statement-breakpoint
-- Only the head of its (now single) dynasty may be Active.
UPDATE "prompts" p SET "status" = 'deprecated', "status_reason" = 'Upgraded',
  "status_changed_by" = 'template-dynasty-upgrade', "status_changed_at" = now()
FROM "template_dynasty_versions" v
WHERE v."prompt_type" = p."type" AND p."status" = 'active'
  AND v."position" < (SELECT max(h."position") FROM "template_dynasty_versions" h WHERE h."dynasty_slug" = v."dynasty_slug");
--> statement-breakpoint
-- "Upgraded" means a newer version exists: on a head it is false. Three heads carried it (the
-- 2026-10-21 15:43 backfill ran while they were older versions, then 0037 made them heads of the
-- twin dynasties). They are Active again; any other stated reason (e.g. "Deceptive") stays.
UPDATE "prompts" p SET "status" = 'active', "status_reason" = NULL,
  "status_changed_by" = 'template-dynasty-upgrade', "status_changed_at" = now()
FROM "template_dynasty_versions" v
WHERE v."prompt_type" = p."type" AND p."status" = 'deprecated' AND p."status_reason" = 'Upgraded'
  AND v."position" = (SELECT max(h."position") FROM "template_dynasty_versions" h WHERE h."dynasty_slug" = v."dynasty_slug");
--> statement-breakpoint
DROP TABLE IF EXISTS "tdv_0038";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_template_dynasty_versions_type" ON "template_dynasty_versions" ("prompt_type");
