/**
 * The campaign's own instruction: free text the campaign owner wrote for THIS campaign
 * ("write as Kevin to a signup who never talked with us, thank them, ask ONE open question").
 *
 * campaign-service owns it (a sales-funnel campaign's `instruction`, reported to every run of
 * its units by `/start-run`); workflow-service threads it into every `/generate` body the way it
 * threads the offer. Every outreach channel writes from it: before this existed the WhatsApp
 * workflow read it and the cold-email path dropped it, so a signup got a generic cold pitch
 * (LEAK-1012).
 *
 * It lives in the SYSTEM prompt, after every other rule, because the email templates are
 * hand-tuned stored bodies across dozens of versions: a rule here reaches every one of them
 * without editing a stored body, and it outranks the template's own angle. It never outranks
 * the output format or the universal rules (no signature, no placeholder).
 *
 * Standalone leaf module (never `vi.mock`'d): `schemas.ts` reads MAX_INSTRUCTION_LENGTH.
 */

/** campaign-service's own cap (`MAX_INSTRUCTION_LENGTH` there). */
export const MAX_INSTRUCTION_LENGTH = 4000;

/** The instruction as the writer should read it, or null when the run carries none. */
export function normalizeInstruction(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

/** The rule appended to the system prompt. "" when there is no instruction. */
export function buildCampaignInstructionDirective(instruction: string | null | undefined): string {
  const text = normalizeInstruction(instruction);
  if (!text) return "";
  return [
    "",
    "The campaign's own INSTRUCTION (written by the sender for this campaign; it overrides the prompt above, every rule above about what to offer or ask, and the template's angle, pitch, structure, length and number of steps):",
    "<<<",
    text,
    ">>>",
    "- Follow it. Write exactly the email it asks for, to this recipient, and nothing it does not ask for.",
    "- If it asks for a single email, return a single step in `emails`.",
    "- State only what the instruction or the inputs above say. Never invent a figure, a price, a promise, a result or a customer.",
    "- It never changes the JSON format above, and never the universal rules (no sign-off, no placeholder).",
  ].join("\n");
}
