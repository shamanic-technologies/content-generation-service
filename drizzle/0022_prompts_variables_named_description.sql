-- Transform prompts.variables from legacy string[] shape into Array<{ name, description }>.
--
-- Multibrand-flex template inputs (DIS-52): each stored prompt now self-documents
-- the inputs it expects via a `description` field per variable. Legacy rows that
-- shipped as bare string arrays are migrated forward in-place with an empty
-- description that the template owner can populate later via PUT /prompts.
--
-- Idempotent: the WHERE clause only matches arrays whose first element is a string.

UPDATE prompts
SET variables = (
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('name', value, 'description', '')),
    '[]'::jsonb
  )
  FROM jsonb_array_elements_text(variables) AS value
)
WHERE jsonb_typeof(variables) = 'array'
  AND jsonb_array_length(variables) > 0
  AND jsonb_typeof(variables -> 0) = 'string';
