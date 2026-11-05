/**
 * The campaign's brief: the one free text a campaign carries about what to say and to whom
 * (campaign-service's sales-funnel campaign `brief`, which the client edits on the dashboard
 * campaign page). ONE-BRIEF-1105 (owner 2026-11-05: « que le text de stratégie de la campaign soit
 * donné en input à tous les LLM (pas que email, de façon structurelle pour tous les clients) »).
 *
 * workflow-service threads it into the body of every writer door of this service (`/generate`,
 * `/generate/materials`, `/generate-whatsapp`, `/generate-thread`) as `brief`, the way it threads
 * the offer. Every writer reads it through ONE directive (`buildCampaignBriefDirective`), appended
 * to its SYSTEM prompt: it outranks the template's angle, pitch and structure, never the output
 * format, our voice, or what the thread and the person's relationship to us say.
 *
 * Transition: the campaign's old second text `instruction` (only the AI assistant could write it,
 * the client could not see it) is folded into the brief by campaign-service and removed.
 * `/generate` still reads `instruction` when the run sends no brief, until workflow-service sends
 * the brief; then that fallback is deleted.
 *
 * Standalone leaf module (never `vi.mock`'d): `schemas.ts` reads MAX_BRIEF_LENGTH.
 */

/** Generous ceiling: campaign-service caps the brief at 8000 and folds the old instruction (4000) into it. */
export const MAX_BRIEF_LENGTH = 20000;

/** A text as the writer should read it, or null when absent, blank or not a string. */
export function normalizeBrief(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

/** The run's brief: `brief` when sent, else the legacy `instruction` (transition only). */
export function resolveCampaignBrief(body: { brief?: unknown; instruction?: unknown }): string | null {
  return normalizeBrief(body.brief) ?? normalizeBrief(body.instruction);
}

/** The rule appended to a writer's system prompt. "" when there is no brief. */
export function buildCampaignBriefDirective(brief: string | null | undefined): string {
  const text = normalizeBrief(brief);
  if (!text) return "";
  return [
    "",
    "The campaign's BRIEF (written by the sender for this whole campaign; it overrides the template's angle, pitch, structure and length, and every rule above about what to offer or ask):",
    "<<<",
    text,
    ">>>",
    "- Follow it. Write the message it asks for, to this person, and nothing it does not ask for. If it asks for a single message, write a single one.",
    "- It was written for the whole campaign without knowing this person: where it assumes something the thread or who they already are to us contradicts (that you never talked, that they are a stranger, which language to use), the thread and who they are to us win.",
    "- State only what the brief or the inputs say. Never invent a figure, a price, a promise, a result or a customer.",
    "- It never changes the output format above, our voice, or the universal rules (no sign-off, no placeholder).",
  ].join("\n");
}
