-- THREADS-IDEAS-AB: a staff dry run's thread (written, never published) is marked so features-service
-- never counts its spend against the template or the LLM that wrote it.
ALTER TABLE IF EXISTS "thread_generations" ADD COLUMN IF NOT EXISTS "dry_run" boolean DEFAULT false NOT NULL;
