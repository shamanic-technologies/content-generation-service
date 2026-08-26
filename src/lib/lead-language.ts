/**
 * Which language a generated email should be written in, given the business
 * languages lead-service reports for the recipient.
 *
 * The list is produced by human-service (the canonical producer of the person)
 * and carried through lead-service as `businessLanguages`: ISO 639-1 lowercase
 * codes, ORDERED most-plausible-first. That ordering is the contract — selection
 * here is by position, so an unordered list would make this meaningless.
 *
 * The rule, deliberately English-preferring:
 *
 *   absent / empty                → null (no directive, English)
 *   contains English anywhere     → null (no directive, English)
 *   otherwise                     → the first entry
 *
 * Returning `null` means "emit no language directive at all", which leaves the
 * prompt byte-identical to what it was before this feature existed. That is not
 * a fabricated fallback standing in for missing producer data: an empty list is
 * the producer truthfully saying it has no signal, and English for that case is a
 * documented decision made here, by the consumer, not guessed upstream.
 *
 * Consequence worth stating plainly, because it bounds the whole feature: a
 * recipient who can do business in English gets English even when another
 * language leads the list. The directive only ever fires for someone with no
 * English at all.
 */

/** "en" is the contract's spelling; the full word is accepted for robustness. */
function isEnglish(language: string): boolean {
  const l = language.trim().toLowerCase();
  return l === "en" || l === "eng" || l === "english";
}

/**
 * Turn an ISO 639-1 code into the English name of that language, or `null` when
 * the runtime cannot resolve it.
 *
 * `Intl.DisplayNames` is used instead of a hand-written code→name table so there
 * is nothing here to drift from the producer's vocabulary as it grows. It echoes
 * the input back unchanged for a code it does not know, which is how an
 * unresolvable value is detected — instructing a model to "write in zz" would be
 * worse than not instructing it at all.
 */
export function languageNameFromCode(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return null;

  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(trimmed.toLowerCase());
  } catch {
    return null;
  }

  if (!name || name.toLowerCase() === trimmed.toLowerCase()) return null;
  return name;
}

/**
 * Resolve the language to instruct the model to write in, or `null` for
 * "no directive" (which the caller must treat as English).
 *
 * Returns the language NAME ("German"), not the code — the directive is read by
 * an LLM, and "write the email in de" instructs nothing.
 */
export function resolveLeadLanguage(businessLanguages: unknown): string | null {
  if (!Array.isArray(businessLanguages)) return null;

  const codes = businessLanguages.filter(
    (l): l is string => typeof l === "string" && l.trim().length > 0
  );
  if (codes.length === 0) return null;
  if (codes.some(isEnglish)) return null;

  const name = languageNameFromCode(codes[0]);
  if (!name) {
    console.error(
      `[lead-language] Unresolvable language code "${codes[0]}" — generating without a language directive.`
    );
    return null;
  }
  return name;
}
