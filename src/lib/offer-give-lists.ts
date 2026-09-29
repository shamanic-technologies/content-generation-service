/**
 * The offer's two "give" lists, as the customer confirmed them in brand-service:
 *  - `giveForFree`: what they will give a prospect who replies (a free audit, a
 *    trial, a sample). The email uses one of these as the reason to reply.
 *  - `neverGive`: what they will NOT give (discounts, free implementation). The
 *    email never offers, promises or hints at any of these.
 *
 * Only CONFIRMED values count. brand-service's user-fields view also carries a
 * `suggested` half (an auto-extract prefill read off the brand's site); a list the
 * customer never confirmed is not a promise they made, so it is never used. An
 * empty or absent list means "nothing to offer": no rule is emitted and the email
 * is written exactly as before this existed. Nothing is ever invented to fill it.
 *
 * Pure leaf module (no I/O, never `vi.mock`'d).
 */

export interface OfferGiveLists {
  giveForFree: string[];
  neverGive: string[];
}

export const EMPTY_GIVE_LISTS: OfferGiveLists = { giveForFree: [], neverGive: [] };

/** brand-service's user-fields view: `{ fields: { <key>: { value, provenance } } }`. */
interface UserFieldsView {
  fields?: Record<string, { value?: unknown; provenance?: unknown } | undefined>;
}

function toItems(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const items: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const item = v.trim();
    if (item && !items.includes(item)) items.push(item);
  }
  return items;
}

function confirmedItems(view: UserFieldsView, key: keyof OfferGiveLists): string[] {
  const field = view.fields?.[key];
  if (!field || field.provenance !== "confirmed") return [];
  return toItems(field.value);
}

/** The two lists out of a user-fields view, confirmed values only. */
export function parseOfferGiveLists(view: unknown): OfferGiveLists {
  const v = (view ?? {}) as UserFieldsView;
  return {
    giveForFree: confirmedItems(v, "giveForFree"),
    neverGive: confirmedItems(v, "neverGive"),
  };
}

export function hasGiveLists(lists: OfferGiveLists | null | undefined): lists is OfferGiveLists {
  return !!lists && (lists.giveForFree.length > 0 || lists.neverGive.length > 0);
}

/**
 * The rule appended to the system prompt. It lives in the SYSTEM prompt, like the
 * language directive, because the templates are hand-tuned per org across dozens
 * of stored versions: a rule here reaches every one of them without editing a
 * stored body. Returns "" when both lists are empty.
 */
export function buildGiveListsDirective(lists: OfferGiveLists): string {
  if (!hasGiveLists(lists)) return "";
  const lines = ["", "What the sender offers (stated by the sender; these rules override the prompt above):"];
  if (lists.giveForFree.length > 0) {
    lines.push(
      "- The sender gives the following for free to a prospect who replies:",
      ...lists.giveForFree.map((item) => `  - ${item}`),
      "- Make ONE of these the ask of the first email: the concrete thing the prospect gets by replying. Pick the one that fits this prospect best, name it plainly, and make replying the way to get it. It replaces a generic call to action (\"worth a chat?\", \"open to a call?\"). Follow-up steps may come back to it.",
      "- Describe it exactly as stated. Do not enlarge it, attach conditions, or add anything the sender did not list."
    );
  }
  if (lists.neverGive.length > 0) {
    lines.push(
      "- The sender will NEVER give the following. Do not offer, promise, suggest or hint at any of them, in any step of the sequence, not even as a possibility:",
      ...lists.neverGive.map((item) => `  - ${item}`)
    );
  }
  return lines.join("\n");
}

/** A stable fingerprint of the lists, for cache keys. "" when both are empty. */
export function giveListsFingerprint(lists: OfferGiveLists | null | undefined): string {
  if (!hasGiveLists(lists)) return "";
  const norm = (items: string[]) => items.map((i) => i.trim().toLowerCase().replace(/\s+/g, " "));
  return JSON.stringify([norm(lists.giveForFree), norm(lists.neverGive)]);
}
