// Blind emails: the client stays anonymous (BLIND-WRITER-1017).
//
// A template whose TYPE starts with one of BLIND_TEMPLATE_TYPE_PREFIXES promises the
// prospect never learns who the client is from the email: no name, no brand, no
// website, no link. features-service tags a workflow "Blind angle" on that type alone,
// and the "Blind emails only" play sells exactly that promise. Templates and brand
// intel used to contradict it ("the client name if recognizable", the URL "lightly"),
// and the brand intel handed to the writer carries the name, so 3% to 41% of first
// emails per brand named the client (measured on 30 days, 2026-10-17).
//
// So the promise is kept HERE, for every template version past and future, never by
// trusting the model:
//  1. a system-prompt rule naming the exact strings the writer must not write, appended
//     LAST so it outranks the template, the brand intel and the campaign instruction;
//  2. a literal check of the subject and every email of the answer against the brand's
//     name and domain(s); a hit asks the model to REWRITE the draft without them, up to
//     MAX_BLIND_REWRITES times, then fails loud (BlindClientNamedError → 502). An email
//     naming the client is never stored nor returned.
// Every email of the sequence is checked, not only the first: a follow-up goes out only
// while the prospect has not replied, so it is still written to a stranger.
//
// Not applied when the recipient already knows the brand (they signed up, booked, wrote
// to it, or a thread exists): a warm re-engagement campaign on a blind-type template
// names the brand by design, and the Blind play never reaches those people.
//
// Standalone leaf (no db, no fetch): never vi.mock'd.

export const BLIND_TEMPLATE_TYPE_PREFIXES = ["blind-discovery-email", "feedback-request-blind-email"] as const;

/** True for every version of a blind-type template (`blind-discovery-email-v34`, `-v9-landing-v3`, ...). */
export function isBlindTemplateType(type: string): boolean {
  return BLIND_TEMPLATE_TYPE_PREFIXES.some((p) => type === p || type.startsWith(`${p}-`));
}

/** Rewrites of a draft that named the client, after the first answer. */
export const MAX_BLIND_REWRITES = 2;

/** What the email must never contain: the brand name(s) and domain(s). */
export interface BlindIdentity {
  names: string[];
  domains: string[];
}

function hostOf(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The identity to keep out of the email, from brand rows (`{ name, domain, url }`, as
 * brand-service serves them). A name with spaces also yields its compact spelling
 * ("Living Vital" → "LivingVital"), the way it appears in handles and domains.
 */
export function blindIdentityFromBrands(
  brands: ReadonlyArray<{ name?: unknown; domain?: unknown; url?: unknown }>
): BlindIdentity {
  const names = new Set<string>();
  const domains = new Set<string>();
  for (const b of brands) {
    if (typeof b.name === "string" && b.name.trim().length >= 2) {
      const name = b.name.trim();
      names.add(name);
      const compact = name.replace(/\s+/g, "");
      if (compact !== name && compact.length >= 4) names.add(compact);
    }
    for (const v of [b.domain, b.url]) {
      const host = typeof v === "string" ? hostOf(v) : null;
      if (host && host.includes(".")) domains.add(host);
    }
  }
  return { names: [...names], domains: [...domains] };
}

export function hasBlindIdentity(identity: BlindIdentity | null | undefined): identity is BlindIdentity {
  return !!identity && identity.names.length + identity.domains.length > 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every identity string written in `text`, case-insensitive, as a whole word / host. */
export function findClientMentions(text: string, identity: BlindIdentity): string[] {
  const found: string[] = [];
  for (const name of identity.names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(text)) found.push(name);
  }
  for (const domain of identity.domains) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRe(domain)}(?![\\p{L}\\p{N}-])`, "iu");
    if (re.test(text)) found.push(domain);
  }
  return found;
}

export interface ClientMention {
  /** `subject` or `email <n>`. */
  where: string;
  terms: string[];
}

/** Where the answer names the client: the subject and each email body. Empty = anonymous. */
export function findSequenceClientMentions(
  answer: { subject: string; sequence: ReadonlyArray<{ bodyText: string }> },
  identity: BlindIdentity
): ClientMention[] {
  const out: ClientMention[] = [];
  const subjectTerms = findClientMentions(answer.subject, identity);
  if (subjectTerms.length) out.push({ where: "subject", terms: subjectTerms });
  answer.sequence.forEach((step, i) => {
    const terms = findClientMentions(step.bodyText, identity);
    if (terms.length) out.push({ where: `email ${i + 1}`, terms });
  });
  return out;
}

export function describeMentions(mentions: ReadonlyArray<ClientMention>): string {
  return mentions.map((m) => `${m.where}: ${m.terms.map((t) => `"${t}"`).join(", ")}`).join("; ");
}

function quotedList(identity: BlindIdentity): string {
  return [...identity.names, ...identity.domains].map((t) => `"${t}"`).join(", ");
}

/** The system-prompt rule, appended LAST so it outranks every rule and input before it. */
export function buildBlindDirective(identity: BlindIdentity): string {
  return [
    "",
    "The client stays anonymous (this overrides the template, the brand intelligence, the campaign instruction and every rule above):",
    `- Never write the client's name, brand, website, domain or any link to the client, in the subject line or in any email of the sequence. Here that means never writing ${quotedList(identity)}, in any spelling.`,
    '- Refer to the client as "the team I work with", "a team I represent" or similar. The prospect learns who they are only by replying.',
    "- The brand intelligence and every client detail above are for your understanding only.",
  ].join("\n");
}

/** The user message of a rewrite: the draft that named the client, and what to change. */
export function buildBlindRewriteMessage(
  draft: { subject: string; emails: ReadonlyArray<{ body: string; daysSinceLastStep: number }> },
  mentions: ReadonlyArray<ClientMention>,
  identity: BlindIdentity
): string {
  return [
    "Below is a draft email sequence (JSON). It breaks the rule that the client stays anonymous: it names the client.",
    `Found: ${describeMentions(mentions)}.`,
    "",
    `Rewrite it so that no subject line and no email contains the client's name, brand, website, domain or any link to the client (never ${quotedList(identity)}). Where the draft named them, say "the team I work with" or similar, and drop any link to them.`,
    "Change only what that needs. Keep the language, the length, the structure, the number of emails and every daysSinceLastStep exactly as they are.",
    "",
    "Draft:",
    JSON.stringify(draft),
  ].join("\n");
}

/**
 * True when the recipient already knows the brand: lead-service tagged them (prospect,
 * customer...), judged them known, or a thread with them exists. Read off the raw
 * `leadRelationship` variable workflow-service sends. Absent = a stranger.
 */
export function recipientAlreadyKnowsBrand(rawRelationship: unknown): boolean {
  if (!rawRelationship || typeof rawRelationship !== "object" || Array.isArray(rawRelationship)) return false;
  const r = rawRelationship as Record<string, unknown>;
  if (r.state === "known") return true;
  if (Array.isArray(r.tags) && r.tags.length > 0) return true;
  if (r.hasThread === true) return true;
  return Array.isArray(r.threadLines) && r.threadLines.length > 0;
}

/** The answer still named the client after every rewrite. Nothing is stored; the route answers 502. */
export class BlindClientNamedError extends Error {
  readonly code = "BLIND_CLIENT_NAMED";
  readonly mentions: ClientMention[];

  constructor(mentions: ClientMention[], attempts: number) {
    super(
      `Blind template: the email still names the client after ${attempts} attempt(s) (${describeMentions(mentions)}). Not stored, not sent.`
    );
    this.name = "BlindClientNamedError";
    this.mentions = mentions;
  }
}

/** The brand's name/domain could not be read for a blind template: the email is not written. Route answers 502. */
export class BlindBrandUnreadableError extends Error {
  readonly code = "BLIND_BRAND_UNREADABLE";

  constructor(cause: string) {
    super(`Blind template: the brand could not be read, so the email cannot be kept anonymous. ${cause}`);
    this.name = "BlindBrandUnreadableError";
  }
}
