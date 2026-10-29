-- FACTORY-P3-RECORD-SYSTEM-PROMPT: the exact chat-service /complete body each email generation sent
-- (message, systemPrompt, responseSchema, provider, model) and what it was built from beyond
-- variables_raw (template text, campaign context, language, give lists, instruction, client-comms voice).
-- NULL on rows written before. Read by GET /internal/generations/recorded in (created_at, id) order.
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "chat_request" jsonb;
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "chat_request_inputs" jsonb;
CREATE INDEX IF NOT EXISTS "idx_emailgen_recorded_created" ON "email_generations" ("created_at", "id")
  WHERE "chat_request" IS NOT NULL;
