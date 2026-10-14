/**
 * Who the recipient ALREADY is to the brand, and what was already said to them
 * (RELATIONSHIP-TAGS-1014).
 *
 * Incident 2026-10-12/13: the owner ran campaigns to distribute.you's own signups, some of
 * them friends he talks with every week, and every writer believed they were strangers.
 * lead-service now judges each person's relationship to the brand (tags read off their whole
 * merged thread) and workflow-service's shared step hands every writer the same object. Here it
 * arrives as the optional variable `leadRelationship` on `POST /generate`.
 *
 * Two halves, both appended only when the variable is present and well formed:
 *  - the FACTS (relationship sentences, the thread, recent events) go in the user prompt,
 *    ahead of the recipient context, so the model reads them next to the person;
 *  - the STRATEGY goes LAST in the system prompt, after the campaign's instruction, because it
 *    must win over a stored template written as a first contact (and over an instruction that
 *    assumes one). The strategy text is the caller's, word for word: one game, identical in
 *    every writer, never restated here.
 *
 * Absent, null, or a value without a recognised `state` leaves both prompts byte-identical.
 * Standalone leaf module (never `vi.mock`'d).
 */

export const LEAD_RELATIONSHIP_VARIABLE = "leadRelationship";

export const LEAD_RELATIONSHIP_STATES = ["known", "possibly_known", "not_known"] as const;
export type LeadRelationshipState = (typeof LEAD_RELATIONSHIP_STATES)[number];

export interface LeadRelationship {
  state: LeadRelationshipState;
  judged: boolean;
  lines: string[];
  hasThread: boolean;
  threadLines: string[];
  olderMessagesOmitted: number;
  eventLines: string[];
  strategy: string | null;
}

/** Published beside the lead context catalog on every prompt read (`contextVariables`). */
export const LEAD_RELATIONSHIP_PUBLISHED = {
  name: LEAD_RELATIONSHIP_VARIABLE,
  description:
    "Who the recipient already is to the brand and what was already said to them, as workflow-service's shared relationship step builds it from lead-service relationship tags and crm-service's merged thread: { state ('known' | 'possibly_known' | 'not_known'), known, judged, tags, unsureTags, lines (the relationship in plain sentences), hasThread, threadLines (oldest first), olderMessagesOmitted, eventLines, strategy (the writing strategy, word for word) }. Rendered as its own section ahead of the template, and its strategy is appended last to the system prompt, where it wins over a template written as a first contact. Absent = prompt unchanged.",
};

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** The relationship as the writer reads it, or null when the request carries none usable. */
export function normalizeLeadRelationship(raw: unknown): LeadRelationship | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`[content-gen] ${LEAD_RELATIONSHIP_VARIABLE} is not an object, not rendered`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!LEAD_RELATIONSHIP_STATES.includes(r.state as LeadRelationshipState)) {
    console.warn(
      `[content-gen] ${LEAD_RELATIONSHIP_VARIABLE} carried no recognised state (${JSON.stringify(r.state)}), not rendered`
    );
    return null;
  }
  const threadLines = strings(r.threadLines);
  const omitted = typeof r.olderMessagesOmitted === "number" && r.olderMessagesOmitted > 0
    ? Math.floor(r.olderMessagesOmitted)
    : 0;
  const strategy = typeof r.strategy === "string" && r.strategy.trim().length > 0 ? r.strategy.trim() : null;
  return {
    state: r.state as LeadRelationshipState,
    judged: r.judged === true,
    lines: strings(r.lines),
    hasThread: r.hasThread === true || threadLines.length > 0,
    threadLines,
    olderMessagesOmitted: omitted,
    eventLines: strings(r.eventLines),
    strategy,
  };
}

function stateSentence(rel: LeadRelationship): string {
  if (rel.state === "known") return "We ALREADY KNOW this person.";
  if (rel.state === "possibly_known") return "We may already know this person: treat them as someone we know until the thread says otherwise.";
  if (!rel.judged) return "Nobody has judged yet whether we know this person: read the thread before assuming a first contact.";
  if (rel.hasThread) return "This person was judged none of the known relationships, but we have already exchanged messages: continue that exchange.";
  return "This person was judged none of the known relationships and we have never exchanged a message with them.";
}

/** The facts section placed in the user prompt, ahead of the template. "" when absent. */
export function buildLeadRelationshipBlock(rel: LeadRelationship | null): string {
  if (!rel) return "";
  const out: string[] = [
    "## Who this person already is to us",
    stateSentence(rel),
    ...rel.lines.map((l) => `- ${l}`),
  ];
  out.push("");
  if (rel.threadLines.length > 0) {
    out.push("### Our conversation with them so far (oldest first)");
    if (rel.olderMessagesOmitted > 0) {
      out.push(`(${rel.olderMessagesOmitted} older messages not shown)`);
    }
    out.push(...rel.threadLines);
  } else {
    out.push("### Our conversation with them so far", "No message between us and this person is on record.");
  }
  if (rel.eventLines.length > 0) {
    out.push("", "### Recent events", ...rel.eventLines.map((l) => `- ${l}`));
  }
  return out.join("\n");
}

/** The rule appended LAST to the system prompt. "" when absent. */
export function buildLeadRelationshipDirective(rel: LeadRelationship | null): string {
  if (!rel) return "";
  const out = [
    "",
    "WHO THE RECIPIENT ALREADY IS TO US (see the section \"Who this person already is to us\" in the message). This wins over the prompt above, the template's angle and framing, and any instruction above that assumes a first contact. It never changes the JSON format above, and never the universal rules (no sign-off, no placeholder).",
  ];
  if (rel.strategy) {
    out.push("The strategy, word for word:", "<<<", rel.strategy, ">>>");
  }
  out.push(
    "- A template written as a cold first contact gives you only the PURPOSE of this email, never its framing. To someone we know, write as someone who knows them, continuing the relationship and the conversation shown, in the language and tone of that conversation.",
    "- Never a cold introduction, never \"I came across your profile\", never a pitch written to a stranger, never a claim that we have never met unless the section says we never exchanged a message and they were judged none of the known relationships.",
    "- Never mention how we classify them (no tag, no label).",
  );
  return out.join("\n");
}
