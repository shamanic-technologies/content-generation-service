/**
 * Which language a generated email should be written in, given the languages
 * lead-service reports for the recipient.
 *
 * The list is produced by human-service (the canonical producer of the person)
 * and carried through lead-service. Its ONE contractual property here is that it
 * is ORDERED — most plausible language first. Selection is by position, so an
 * unordered list would make this function meaningless.
 *
 * The rule, deliberately English-preferring:
 *
 *   absent / empty                     → null (no directive, English)
 *   contains English (case-insensitive) → null (no directive, English)
 *   otherwise                          → the first entry
 *
 * Returning `null` means "emit no language directive at all", which leaves the
 * prompt byte-identical to what it was before this feature existed. That is not
 * a fabricated fallback standing in for missing producer data: an absent list is
 * the producer truthfully saying it does not know, and English is the documented
 * decision for that case — made here, by the consumer, not guessed upstream.
 *
 * Consequence worth stating plainly, because it bounds the whole feature: a
 * recipient who can do business in English gets English even when another
 * language leads the list. The directive only ever fires for someone with no
 * English at all.
 */

/** Matches "English" in any casing, with surrounding whitespace tolerated. */
function isEnglish(language: string): boolean {
  return language.trim().toLowerCase() === "english";
}

/**
 * Resolve the language to instruct the model to write in, or `null` for
 * "no directive" (which the caller must treat as English).
 */
export function resolveLeadLanguage(languages: unknown): string | null {
  if (!Array.isArray(languages)) return null;

  const named = languages.filter(
    (l): l is string => typeof l === "string" && l.trim().length > 0
  );
  if (named.length === 0) return null;
  if (named.some(isEnglish)) return null;

  return named[0].trim();
}
