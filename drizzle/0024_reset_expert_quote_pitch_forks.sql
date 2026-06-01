-- Reset stale expert-quote-pitch forks + feature assignment.
--
-- The expert-quote-pitch template contract changed from the old opaque
-- {brand, request, additionalContext} set to explicit, all-required
-- brands[] + expert attribution + journalistRequest + expertAnswerContext.
--
-- Every org fork (expert-quote-pitch-v2 … vN) carries the OLD variable set and
-- would render unfilled / broken pitches. The single feature assignment points
-- pr-expert-quote-opportunities at a stale fork (v7), shadowing the rebuilt
-- platform default. Drop both so the feature resolves to the new platform
-- default (org_id IS NULL), which registerPlatformTemplates() UPSERTs at boot
-- right after this migration runs.
--
-- Idempotent: re-running deletes nothing more. Only touches the expert-quote-pitch
-- fork family; the platform default row and all other templates are untouched.

DELETE FROM "feature_prompt_assignment" WHERE "prompt_type" LIKE 'expert-quote-pitch-v%';

DELETE FROM "prompts" WHERE "type" LIKE 'expert-quote-pitch-v%';
