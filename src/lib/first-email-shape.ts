/**
 * How the FIRST email of a sequence is laid out, how it opens and which dashes it carries,
 * read on its own stored text. Deterministic (no model is asked anything), so a study built on
 * these classes is reproducible.
 *
 * Ported from distribute.you apps/landing/scripts/blog-data/first-email-shape.mjs (the nightly
 * Research scripts), which features-service replaces with a live read of GET /internal/sequences.
 * Sharpened on the port:
 *  - the recipient's own first name is tested BEFORE the greeting list, so a lead named
 *    "Ola", "Cara" or "Caro" opening "Ola, I saw..." is the name alone, not a greeting;
 *  - an HTML-entity dash (`&mdash;`, `&#8212;`, `&ndash;`, `&#8211;`) counts as the dash it
 *    renders as;
 *  - a few interjections glued to a comma or "!" ("Wow!", "Hope,") are not first names.
 *
 * Standalone leaf (imports nothing), safe to read from any route or unit suite.
 */

export type FirstEmailLayout = "one_block" | "single_line_breaks" | "double_line_breaks";
export type FirstEmailOpening = "greeting" | "first_name_alone" | "no_greeting";
export type FirstEmailDash = "em" | "en" | "both" | "none";

export interface FirstEmailShape {
  layout: FirstEmailLayout;
  opening: FirstEmailOpening;
  dash: FirstEmailDash;
}

const normalize = (body: string): string => body.replace(/\r\n?/g, "\n").trim();

/** A blank line between two blocks is a paragraph break; a single line break is not; none is one block. */
export function layoutOf(body: string): FirstEmailLayout {
  const text = normalize(body);
  if (/\n[ \t]*\n/.test(text)) return "double_line_breaks";
  if (text.includes("\n")) return "single_line_breaks";
  return "one_block";
}

const GREETINGS = [
  // English
  "hi", "hello", "hey", "dear", "good morning", "good afternoon", "good evening", "greetings", "howdy",
  // French
  "bonjour", "bonsoir", "salut", "coucou", "cher", "chère", "chere",
  // German
  "hallo", "liebe", "lieber", "sehr geehrte", "sehr geehrter", "guten tag", "guten morgen", "moin", "servus", "grüezi", "gruezi", "grüß gott",
  // Spanish / Portuguese
  "hola", "estimado", "estimada", "buenos días", "buenos dias", "buenas tardes", "buenas", "olá", "ola", "oi", "prezado", "prezada", "bom dia", "boa tarde",
  // Italian
  "ciao", "buongiorno", "buonasera", "gentile", "caro", "cara", "salve",
  // Dutch / Nordic
  "hoi", "beste", "goedemorgen", "goedemiddag", "hej", "hei", "moi", "god morgon",
  // Polish / Turkish / other
  "cześć", "czesc", "dzień dobry", "dzien dobry", "szanowny", "szanowna", "merhaba", "shalom",
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GREETING_RE = new RegExp(
  `^(?:${[...GREETINGS].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\p{L}])`,
  "iu",
);
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Words that open a cold email glued to a comma, colon, "!" or dash without being a name.
const NOT_A_NAME = new Set([
  "however", "honestly", "quick", "so", "also", "well", "yes", "ok", "okay", "look", "listen", "question",
  "curious", "note", "ps", "fyi", "update", "today", "recently", "firstly", "first", "sorry", "thanks",
  "congrats", "congratulations", "apologies", "cependant", "donc", "bref", "alors", "aber", "kurz",
  "wow", "hope", "great", "imagine", "interesting", "fun", "ps.", "p.s.", "p.s",
]);
const GLUED = /^(\p{Lu}[\p{L}'’.-]{0,24})\s*[,:!–—]/u;
const GLUED_ASCII_DASH = /^(\p{Lu}[\p{L}'’.]{0,24})\s+-\s/u;

/**
 * A greeting word in any language we write in, whatever follows it; else a first name glued to
 * the first sentence ("Marie, la plupart..."), the recipient's own or any single capitalised word
 * that is not a known opener; else no greeting.
 */
export function openingOf(body: string, firstName: string | null | undefined): FirstEmailOpening {
  const text = normalize(body);
  const name = (firstName ?? "").trim();
  if (
    name &&
    fold(text.slice(0, name.length)) === fold(name) &&
    /^\s*[,:!–—-]/.test(text.slice(name.length, name.length + 3))
  ) {
    return "first_name_alone";
  }
  if (GREETING_RE.test(text)) return "greeting";
  const m = GLUED.exec(text) ?? GLUED_ASCII_DASH.exec(text);
  if (m && !NOT_A_NAME.has(fold(m[1]))) return "first_name_alone";
  return "no_greeting";
}

const EM_RE = /—|&mdash;|&#8212;|&#x2014;/i;
const EN_RE = /–|&ndash;|&#8211;|&#x2013;/i;

/** Em dash (U+2014) and/or en dash (U+2013). A plain hyphen is not a dash. */
export function dashOf(body: string): FirstEmailDash {
  const em = EM_RE.test(body);
  const en = EN_RE.test(body);
  if (em && en) return "both";
  if (em) return "em";
  if (en) return "en";
  return "none";
}

/** The three classes, or `null` when the email carries no copy at all. */
export function firstEmailShape(
  body: string | null | undefined,
  firstName: string | null | undefined,
): FirstEmailShape | null {
  if (typeof body !== "string" || body.trim() === "") return null;
  return { layout: layoutOf(body), opening: openingOf(body, firstName), dash: dashOf(body) };
}
