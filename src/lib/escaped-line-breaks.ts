/**
 * Over-escaped line breaks in LLM output.
 *
 * A model's structured output sometimes returns a body whose newlines are
 * OVER-ESCAPED: the string carries the two characters backslash + `n` instead
 * of a real newline (U+000A). The plain-text-to-HTML conversion splits on real
 * newlines only, so an over-escaped body produces zero paragraph splits and the
 * escape sequences survive into the delivered HTML — visible to the prospect
 * (observed on 53 of 40,979 delivered campaigns, 2026-05-27 → 2026-07-30).
 *
 * These helpers are the single place that converts an escaped line break back
 * into the line break the model meant. Scope is line breaks only — no other
 * model-output defect is touched here.
 *
 * Standalone leaf module (no imports): `src/lib/chat-service-client.ts` is
 * `vi.mock`'d by many suites, so anything that must stay readable at
 * module-eval time lives outside it (see CLAUDE.md "Gotchas").
 */

/**
 * One over-escaped line break. Covers:
 *  - `\n`      (the common case)
 *  - `\r\n`    (escaped CRLF)
 *  - `\r`      (escaped lone CR)
 *  - `\\n`     (double-escaped, i.e. any run of leading backslashes)
 */
const ESCAPED_LINE_BREAK = /\\+r\\+n|\\+[rn]/g;

/** A consecutive run of over-escaped line breaks. */
const ESCAPED_LINE_BREAK_RUN = /(?:\\+r\\+n|\\+[rn])+/g;

/**
 * Turn every over-escaped line break into a real newline, so multi-line text
 * renders exactly as it would have if the model had returned real newlines.
 * Text without escaped line breaks is returned byte-identical.
 */
export function unescapeLineBreaks(text: string): string {
  return text.replace(ESCAPED_LINE_BREAK, "\n");
}

/**
 * Same defect, single-line field (an email subject): collapse each run of
 * over-escaped line breaks to one space instead of unescaping it.
 *
 * A subject is a header — turning the escape into a real newline there would
 * open a header-injection path that the literal text does not have, and a
 * subject has no line breaks to render anyway. Text without escaped line
 * breaks is returned byte-identical.
 */
export function collapseEscapedLineBreaks(text: string): string {
  const collapsed = text.replace(ESCAPED_LINE_BREAK_RUN, " ");
  return collapsed === text ? text : collapsed.replace(/ {2,}/g, " ").trim();
}
