-- RECORDED-ORDER-1111: the recorded generation's variables, chat-service request, inputs and answer as the
-- exact JSON text written (jsonb re-orders object keys, so a replay of the request from variables_raw
-- no longer matched byte for byte). NULL on rows written before. Nullable, no default: instant.
ALTER TABLE IF EXISTS "email_generations" ADD COLUMN IF NOT EXISTS "recorded_text" text;
