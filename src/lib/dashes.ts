/**
 * No em dash (U+2014) or en dash (U+2013) in copy a prospect reads.
 *
 * Fleet-wide owner rule: the ban lives in the prompt AND is enforced
 * deterministically before the send, because models still emit dashes whatever
 * the prompt says. This is the deterministic half for every email this service
 * writes — subject, body and every follow-up — applied before the generation is
 * stored, so the stored record and the send agree.
 *
 * Rewrites, in order:
 *  - HTML entity forms (`&mdash;` `&ndash;` `&#8212;` `&#8211;` `&#x2014;` `&#x2013;`)
 *    are decoded to the dash first, then treated like the character.
 *  - Between two digits ("10–20", "2025 — 2026") → a hyphen: "10-20".
 *  - Leading a line (a list marker) → "- ".
 *  - Ending a line or sitting before closing punctuation → dropped.
 *  - Anywhere else ("word — word", "word—word") → ", ".
 *
 * Text with no dash is returned byte-identical. Standalone leaf (no imports):
 * `chat-service-client.ts` is `vi.mock`'d by many suites (see CLAUDE.md "Gotchas").
 */

const DASH_ENTITY = /&(?:mdash|ndash|#8212|#8211|#x2014|#x2013);/gi;
const EN_DASH_ENTITY = /^&(?:ndash|#8211|#x2013);$/i;
const HAS_DASH = /[–—]|&(?:mdash|ndash|#8212|#8211|#x2014|#x2013);/i;

export function stripDashes(text: string): string {
  if (!HAS_DASH.test(text)) return text;
  return text
    .replace(DASH_ENTITY, (m) => (EN_DASH_ENTITY.test(m) ? "–" : "—"))
    .replace(/(\d)[ \t]*[–—]+[ \t]*(?=\d)/g, "$1-")
    .replace(/^([ \t]*)[–—]+[ \t]*/gm, "$1- ")
    .replace(/[ \t]*[–—]+[ \t]*(?=$|[.,;:!?)\]"”'’])/gm, "")
    .replace(/[ \t]*,?[ \t]*[–—]+[ \t]*/g, ", ");
}

/** True when `stripDashes` would change the text. */
export function hasDashes(text: string): boolean {
  return HAS_DASH.test(text);
}
