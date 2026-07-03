-- Reset stale expert-quote-pitch forks + feature assignment (generic-JSON contract).
--
-- The expert-quote-pitch template contract changed from the explicit, all-required
-- brands[] + granular expert attribution (expertName/expertTitle/expertBio/
-- expertPhotoUrl/expertLinkedIn/expertAnswerContext) + journalistRequest set to
-- THREE generic-JSON variables: expert + brands + journalistRequest.
--
-- Every org fork (expert-quote-pitch-v2 … vN) carries the OLD variable set (granular
-- expert* tokens) and would render unfilled / broken pitches under the new template.
-- Any feature assignment pointing at a stale fork shadows the rebuilt platform
-- default. Drop both so the feature resolves to the new platform default
-- (org_id IS NULL), which registerPlatformTemplates() UPSERTs at boot right after
-- this migration runs.
--
-- Idempotent: re-running deletes nothing more. Only touches the expert-quote-pitch
-- fork family; the platform default row and all other templates are untouched.

DELETE FROM "feature_prompt_assignment" WHERE "prompt_type" LIKE 'expert-quote-pitch-v%';

DELETE FROM "prompts" WHERE "type" LIKE 'expert-quote-pitch-v%';
