/**
 * Why each sentence of the signed-out preview email exists.
 *
 * The reasons are reported by the SAME completion that writes the email (see
 * `annotate` in chat-service-client.ts): no second call, no post-hoc guess. What
 * this module adds is the part a model cannot be trusted with:
 *  - the list of sources is built HERE from the inputs actually sent, so the model
 *    can only name something it was really given;
 *  - every highlight is checked: its text must appear verbatim in the email body
 *    (its offsets are computed here, never taken from the model) and its source
 *    must be on that list. Anything else is dropped, never repaired;
 *  - the source KIND and the source's actual VALUE are attached here from the
 *    inputs, so what the visitor sees as "where this came from" is the real input,
 *    not the model's retelling of it.
 *
 * Pure leaf module (no I/O, never `vi.mock`'d).
 */
import { unescapeLineBreaks } from "./escaped-line-breaks.js";
import type { PreviewRecipient } from "./preview-email.js";

/** Bump when the annotation contract changes, so stored previews are rewritten. */
export const PREVIEW_ANNOTATION_VERSION = "highlights-v1";

/**
 * - `prospect`: a fact about the recipient or their company (the data the caller sent).
 * - `brand`: a fact about the sender's company, read from its site by brand-service.
 * - `audience`: the segment the recipient was found in.
 * - `instruction`: a writing rule of the template (greeting, question, call to action).
 */
export type HighlightKind = "prospect" | "brand" | "audience" | "instruction";

export interface HighlightSource {
  /** Stable id the model names, e.g. `recipient.title`, `brand.customerPainPoints`. */
  id: string;
  kind: HighlightKind;
  /** Plain-English name of the input, shown to the model and to the visitor. */
  label: string;
  /** The input's actual value as the model received it; null for `instruction`. */
  value: string | null;
}

export interface PreviewHighlight {
  /** Verbatim span of `bodyText`. */
  text: string;
  /** Offsets into `bodyText` (JS string indices): `bodyText.slice(start, end) === text`. */
  start: number;
  end: number;
  kind: HighlightKind;
  source: string;
  sourceLabel: string;
  sourceValue: string | null;
  reason: string;
}

const RECIPIENT_LABELS: ReadonlyArray<[keyof PreviewRecipient, string]> = [
  ["firstName", "The prospect's first name"],
  ["title", "The prospect's job title"],
  ["headline", "The prospect's LinkedIn headline"],
  ["companyName", "The prospect's company name"],
  ["companyIndustry", "The prospect's company industry"],
  ["companyDescription", "The prospect's company description"],
  ["companyDomain", "The prospect's company website"],
];

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").trim().toLowerCase();
}

function valueToString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") return Object.keys(value).length > 0 ? JSON.stringify(value) : null;
  return String(value);
}

/**
 * Every input the email could rest on, built from what was actually sent to the
 * model. Inputs that are absent or empty are not offered, so they cannot be named.
 */
export function buildHighlightSources(input: {
  recipient: PreviewRecipient;
  audience?: string;
  brandName: string;
  brandFields: Record<string, { value: unknown } | undefined>;
  /** The offer's confirmed free-give items; the email's ask may rest on them. */
  giveForFree?: readonly string[];
}): HighlightSource[] {
  const sources: HighlightSource[] = [];
  for (const [key, label] of RECIPIENT_LABELS) {
    const value = valueToString(input.recipient[key]);
    if (value) sources.push({ id: `recipient.${key}`, kind: "prospect", label, value });
  }
  const audience = valueToString(input.audience);
  if (audience) {
    sources.push({ id: "audience", kind: "audience", label: "The audience / segment the prospect was found in", value: audience });
  }
  sources.push({ id: "brand.name", kind: "brand", label: "The sender's company name", value: input.brandName });
  for (const [key, field] of Object.entries(input.brandFields)) {
    const value = valueToString(field?.value);
    if (value) {
      sources.push({ id: `brand.${key}`, kind: "brand", label: `The sender's company: ${humanize(key)} (read from its website)`, value });
    }
  }
  const giveForFree = valueToString(input.giveForFree ? [...input.giveForFree] : undefined);
  if (giveForFree) {
    sources.push({ id: "offer.giveForFree", kind: "brand", label: "What the sender gives for free to a prospect who replies (stated by the sender)", value: giveForFree });
  }
  sources.push({ id: "instruction", kind: "instruction", label: "A writing rule of the email template, not a fact", value: null });
  return sources;
}

/**
 * Keep only the highlights that are verifiably true to the email and the inputs,
 * in body order, with no two spans overlapping. A highlight that fails any check
 * is dropped whole; the caller compares counts to log what was dropped.
 */
export function resolveHighlights(
  raw: ReadonlyArray<{ text: unknown; source: unknown; reason: unknown }>,
  bodyText: string,
  sources: ReadonlyArray<HighlightSource>
): PreviewHighlight[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const found: PreviewHighlight[] = [];
  let cursor = 0;
  for (const h of raw) {
    if (typeof h.text !== "string" || typeof h.source !== "string" || typeof h.reason !== "string") continue;
    const source = byId.get(h.source);
    const reason = h.reason.trim();
    if (!source || !reason) continue;
    // The body went through unescapeLineBreaks + trim; the model's copy of it may not have.
    const text = unescapeLineBreaks(h.text).trim();
    if (!text) continue;
    let start = bodyText.indexOf(text, cursor);
    if (start === -1) start = bodyText.indexOf(text);
    if (start === -1) continue;
    const end = start + text.length;
    cursor = end;
    found.push({
      text,
      start,
      end,
      kind: source.kind,
      source: source.id,
      sourceLabel: source.label,
      sourceValue: source.value,
      reason,
    });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PreviewHighlight[] = [];
  for (const h of found) {
    const last = kept[kept.length - 1];
    if (last && h.start < last.end) continue;
    kept.push(h);
  }
  return kept;
}
