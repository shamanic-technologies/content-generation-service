// Single source of truth for parsing {{variable}} tokens out of a prompt template.
// Dependency-free (no env, no db) so it can be imported anywhere — the prompt
// integrity guard and the chat-service client both consume it.

/**
 * Extract the unique {{name}} variable tokens referenced in a template string.
 * Returns the bare names (no braces), de-duplicated, in first-seen order.
 */
export function extractTemplateVariableNames(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}
