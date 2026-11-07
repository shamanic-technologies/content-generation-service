-- DELETE-POST-PUBLISHED-1107 (owner 2026-11-07): the coarse outcome `post_published` is retired fleet-wide;
-- the Threads posts pipe moves from `threads-post` x `start_to_post_published` to
-- `threads-post` x `start_to_threads_post_published` (live in the features-service catalogue).
-- Writer-pick asks for the template dynasties and per-pipe LLM statuses of the pipe the campaign runs,
-- so the rows move WITH it, re-keyed in place: slugs, versions, created/updated dates, every status with its
-- reason, author and date are kept; only the pipe key changes. Idempotent (a re-run finds 0 rows), replayable
-- from an empty database (both tables exist since 0036 / 0043). Prod 2026-11-07: 6 dynasties, 3 statuses.
DO $$
DECLARE
  dyn_before integer;
  dyn_moved integer;
  st_before integer;
  st_moved integer;
BEGIN
  SELECT count(*) INTO dyn_before FROM "template_dynasties"
    WHERE "feature_slug" = 'threads-post' AND "leg_key" = 'start_to_post_published';
  UPDATE "template_dynasties" SET "leg_key" = 'start_to_threads_post_published'
    WHERE "feature_slug" = 'threads-post' AND "leg_key" = 'start_to_post_published';
  GET DIAGNOSTICS dyn_moved = ROW_COUNT;

  SELECT count(*) INTO st_before FROM "model_pipe_statuses"
    WHERE "feature_slug" = 'threads-post' AND "leg_key" = 'start_to_post_published';
  -- A status already stated on the new pipe for the same model wins (never overwritten); the old row then stays.
  UPDATE "model_pipe_statuses" o SET "leg_key" = 'start_to_threads_post_published'
    WHERE o."feature_slug" = 'threads-post' AND o."leg_key" = 'start_to_post_published'
      AND NOT EXISTS (SELECT 1 FROM "model_pipe_statuses" n
        WHERE n."model" = o."model" AND n."feature_slug" = 'threads-post' AND n."leg_key" = 'start_to_threads_post_published');
  GET DIAGNOSTICS st_moved = ROW_COUNT;

  RAISE NOTICE 'DELETE-POST-PUBLISHED-1107: template_dynasties % found, % re-keyed; model_pipe_statuses % found, % re-keyed',
    dyn_before, dyn_moved, st_before, st_moved;
END $$;
