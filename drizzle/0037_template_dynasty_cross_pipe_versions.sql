-- Every template version that wrote on a pipe sits in a dynasty OF THAT PIPE
-- (TPL-DYNASTY-ROWS-1021-CG, owner 2026-10-21). Read 2026-10-21 from the Research catalogue:
-- 18 versions wrote on a pipe where no dynasty listed them, each one already a version of
-- the SAME strategy's dynasty on the other cold-email pipe (cold-reply-* <-> cold-click-*).
-- So each joins its strategy's twin on the pipe where it wrote; a twin that did not exist is
-- created from its sibling (same name, signature, identity; the description says the pipe's
-- goal, "Gets a reply" vs "Gets a website visit"). No head changes on an existing dynasty, so
-- no workflow writes with a different template. Replayable on an empty database (versions
-- join prompts). Idempotent.
INSERT INTO "template_dynasties" ("slug", "name", "description", "signature", "identity", "feature_slug", "leg_key")
SELECT n.slug, t."name", n.description, t."signature", t."identity", t."feature_slug", n.leg_key
FROM (VALUES
  ('cold-reply-recommendation-stack-named', 'cold-click-recommendation-stack-named', 'lead_found_to_conversation',
   'Gets a reply by recommending your brand in short punchy lines: their pain, your name, your proof, your link.'),
  ('cold-reply-brand-first-stack-named', 'cold-click-brand-first-stack-named', 'lead_found_to_conversation',
   'Gets a reply by stacking your proof and your link in short punchy lines, opening on your brand name.'),
  ('cold-click-free-offer-named', 'cold-reply-free-offer-named', 'lead_found_to_website_visit',
   'Gets a website visit by offering the prospect something free from your list, made just for them, with your brand named.'),
  ('cold-click-free-offer-blind', 'cold-reply-free-offer-blind', 'lead_found_to_website_visit',
   'Gets a website visit by offering the prospect something free from your list, like an audit or a benchmark, while keeping your brand private.'),
  ('cold-click-one-line-free-offer-blind', 'cold-reply-one-line-free-offer-blind', 'lead_found_to_website_visit',
   'Gets a website visit by offering a free audit or insight in one single sentence, while keeping your brand private.'),
  ('cold-click-observation-named', 'cold-reply-observation-named', 'lead_found_to_website_visit',
   'Gets a website visit by asking one smart question about the prospect''s challenge, showing you studied their business, with your brand named.')
) AS n(slug, twin, leg_key, description)
JOIN "template_dynasties" t ON t."slug" = n.twin
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Final order of every dynasty touched: oldest first, the current head kept last.
CREATE TABLE IF NOT EXISTS "tdv_0037" (dynasty_slug text, prompt_type text, position int);
--> statement-breakpoint
INSERT INTO "tdv_0037" VALUES
  ('cold-reply-website-click-named', 'cold-email-v12', 1),
  ('cold-reply-website-click-named', 'cold-email-v16', 2),
  ('cold-reply-website-click-named', 'cold-email-v18', 3),
  ('cold-reply-website-click-named', 'cold-email-v31', 4),
  ('cold-reply-website-click-named', 'cold-email-v35', 5),
  ('cold-reply-website-click-named', 'cold-email-v74', 6),
  ('cold-reply-website-click-named', 'cold-email-v69', 7),
  ('cold-click-intro-offer-blind', 'blind-discovery-email-v13', 1),
  ('cold-click-intro-offer-blind', 'blind-discovery-email-v15', 2),
  ('cold-click-intro-offer-blind', 'blind-discovery-email-v26', 3),
  ('cold-click-intro-offer-blind', 'blind-discovery-email-v45', 4),
  ('cold-click-intro-offer-blind', 'blind-discovery-email-v49', 5),
  ('cold-reply-recommendation-stack-named', 'cold-email-v19', 1),
  ('cold-reply-recommendation-stack-named', 'cold-email-v33', 2),
  ('cold-reply-recommendation-stack-named', 'cold-email-v36', 3),
  ('cold-reply-recommendation-stack-named', 'cold-email-v73', 4),
  ('cold-reply-brand-first-stack-named', 'cold-email-v61', 1),
  ('cold-click-free-offer-named', 'blind-discovery-email-v9', 1),
  ('cold-click-free-offer-named', 'blind-discovery-email-v34', 2),
  ('cold-click-free-offer-blind', 'blind-discovery-email-v47-spaced', 1),
  ('cold-click-one-line-free-offer-blind', 'blind-discovery-email-v11', 1),
  ('cold-click-one-line-free-offer-blind', 'blind-discovery-email-v12', 2),
  ('cold-click-observation-named', 'cold-email-v41', 1);
--> statement-breakpoint
-- Park the touched dynasties' rows out of the way of the unique (dynasty, position) index.
UPDATE "template_dynasty_versions" v SET "position" = v."position" + 1000
WHERE v."dynasty_slug" IN (SELECT DISTINCT dynasty_slug FROM "tdv_0037") AND v."position" < 1000;
--> statement-breakpoint
INSERT INTO "template_dynasty_versions" ("dynasty_slug", "prompt_type", "position")
SELECT f.dynasty_slug, f.prompt_type, 2000 + f.position
FROM "tdv_0037" f
JOIN "prompts" p ON p."type" = f.prompt_type
JOIN "template_dynasties" d ON d."slug" = f.dynasty_slug
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "template_dynasty_versions" v SET "position" = f.position
FROM "tdv_0037" f
WHERE v."dynasty_slug" = f.dynasty_slug AND v."prompt_type" = f.prompt_type;
--> statement-breakpoint
DROP TABLE IF EXISTS "tdv_0037";
