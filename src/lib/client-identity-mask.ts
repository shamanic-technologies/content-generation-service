/**
 * BLIND-NAME-LEAK-1105: a writer of a BLIND dynasty never SEES who the client is.
 *
 * The blind head told the writer never to name the client, yet it named it (« I work with the team at
 * Shockwave Centers of America », gemini flash-lite, 2026-11-04): the brand intelligence carried the
 * client's name and domain dozens of times (overview, value proposition, `byBrand` keys, source urls), and
 * one instruction lost against the data. A writer is trusted (owner rule): the fix is what it sees, never
 * a check or a retry on what it wrote. So every input of a blind writer (variables, campaign context, give
 * lists, instruction) is masked BEFORE the writer reads it: the client's name, its domain and every URL or
 * email address on that domain become neutral words; every selling point, figure and proof stays.
 *
 * Pure leaf (no I/O, never `vi.mock`'d). The identity comes from brand-service's brand rows (name, domain,
 * url), never from a variable name or a template type.
 */

/** brand-service could not say who the client is: a blind writer is never handed unmasked inputs. */
export class ClientIdentityError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ClientIdentityError";
  }
}

export interface ClientIdentity {
  name?: unknown;
  domain?: unknown;
  url?: unknown;
}

export interface MaskTerms {
  /** Spellings of the client's name, longest first. */
  names: string[];
  /** The client's registrable hosts, lowercase, without `www.`. */
  domains: string[];
}

export const MASKED_NAME = "the client";
export const MASKED_WEBSITE = "the client's website";
export const MASKED_EMAIL = "the client's email address";

/** Shorter spellings would mask ordinary words of the selling points. */
const MIN_TERM_LENGTH = 4;

const LEGAL_SUFFIX = /[\s,]+(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|limited|corp|corp\.|corporation|co|co\.|gmbh|s\.a\.|sa|sas|sarl|plc|pty|ag|bv|oy|ab)$/i;

function hostOf(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Every spelling of the client's identity the writer must not see, from its brand rows. */
export function clientIdentityTerms(brands: ReadonlyArray<ClientIdentity>): MaskTerms {
  const names = new Set<string>();
  const domains = new Set<string>();
  for (const b of brands) {
    for (const raw of [b.domain, b.url]) {
      if (typeof raw !== "string") continue;
      const host = hostOf(raw);
      if (!host || !host.includes(".")) continue;
      domains.add(host);
      // The domain's label (`docdinners`, `ascendqe`) is how the site writes the name in one word.
      const label = host.split(".")[0];
      if (label.length >= MIN_TERM_LENGTH) names.add(label);
    }
    if (typeof b.name === "string") {
      const name = b.name.trim().replace(/\s+/g, " ");
      const bare = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      const noSuffix = bare.replace(LEGAL_SUFFIX, "").trim();
      for (const n of [name, bare, noSuffix, noSuffix.replace(/[\s-]+/g, "")]) {
        if (n.length >= MIN_TERM_LENGTH) names.add(n);
      }
    }
  }
  const byLength = (a: string, b: string) => b.length - a.length;
  return { names: [...names].sort(byLength), domains: [...domains].sort(byLength) };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Compiled {
  email: RegExp | null;
  url: RegExp | null;
  name: RegExp | null;
}

function compile(terms: MaskTerms): Compiled {
  const doms = terms.domains.map(escape).join("|");
  const names = terms.names.map((n) => escape(n).replace(/\\?\s+/g, "\\s+")).join("|");
  return {
    email: doms ? new RegExp(`[\\p{L}\\p{N}._%+-]+@(?:[a-z0-9-]+\\.)*(?:${doms})(?![\\p{L}\\p{N}-])`, "giu") : null,
    // A URL or bare host on the client's domain (any subdomain, any path; a sentence's closing period stays).
    url: doms
      ? new RegExp(`(?:https?:\\/\\/)?(?<![\\p{L}\\p{N}.-])(?:[a-z0-9-]+\\.)*(?:${doms})(?![\\p{L}\\p{N}-])(?::\\d+)?(?:[/?#](?:[^\\s"'<>)\\]]*[^\\s"'<>)\\].,;:!?])?)?`, "giu")
      : null,
    // "the Doc Dinners team" reads "the client team", never "the the client team".
    name: names ? new RegExp(`(?<![\\p{L}\\p{N}])(the\\s+)?(?:${names})(?![\\p{L}\\p{N}])`, "giu") : null,
  };
}

function maskText(text: string, c: Compiled): string {
  let out = text;
  if (c.email) out = out.replace(c.email, MASKED_EMAIL);
  if (c.url) out = out.replace(c.url, MASKED_WEBSITE);
  if (c.name) out = out.replace(c.name, (_m, the: string | undefined) => (the && /^T/.test(the) ? "The client" : MASKED_NAME));
  return out;
}

function walk(value: unknown, c: Compiled): unknown {
  if (typeof value === "string") return maskText(value, c);
  if (Array.isArray(value)) {
    // Ten source urls on the client's site are one "the client's website", not ten.
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of value) {
      const masked = walk(item, c);
      if (typeof masked === "string") {
        if (seen.has(masked)) continue;
        seen.add(masked);
      }
      out.push(masked);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[maskText(k, c)] = walk(v, c);
    return out;
  }
  return value;
}

/** A deep copy of `value` with every spelling of the client's identity replaced by neutral words. */
export function maskClientIdentity<T>(value: T, terms: MaskTerms): T {
  return walk(value, compile(terms)) as T;
}

/** The spellings still present in `value` (empty = the writer cannot read who the client is). */
export function clientIdentityLeaks(value: unknown, terms: MaskTerms): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const lower = text.toLowerCase();
  return [...terms.names, ...terms.domains].filter((t) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(t.toLowerCase()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "u");
    return re.test(lower);
  });
}
