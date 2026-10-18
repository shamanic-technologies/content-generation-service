/**
 * Our one voice (SOPHIE-COPILOT-WA-1018): HOW every message a client or prospect reads from us
 * is written. chat-service owns it as the skill `client-comms`, edited live by staff; the web
 * and WhatsApp Copilot read the same row. A writer here reads it on EVERY generation (no copy,
 * no cache), so an edit of the skill reaches the next email written.
 *
 * The skill says HOW to write; the template, the campaign instruction and the facts still say
 * WHAT to write. A read that fails throws `ClientCommsVoiceError` (the generation is refused,
 * 502): there is no default voice. Nothing is billed: the read happens before the completion.
 *
 * Standalone leaf, mocked once for every unit suite in `tests/setup.ts` (the suites count the
 * `/complete` fetch calls); `tests/unit/client-comms-voice.test.ts` exercises the real module.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export const CLIENT_COMMS_SKILL_SLUG = "client-comms";

export class ClientCommsVoiceError extends Error {
  status = 502;
  constructor(message: string) {
    super(message);
    this.name = "ClientCommsVoiceError";
  }
}

/** The skill's current markdown body, read live from chat-service. Throws when unreadable. */
export async function readClientCommsVoice(): Promise<string> {
  const base = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
  const url = `${base}/internal/skills/${CLIENT_COMMS_SKILL_SLUG}`;
  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      { method: "GET", headers: { "X-Api-Key": process.env.CHAT_SERVICE_API_KEY || "" } },
      { label: "chat-service skill client-comms" }
    );
  } catch (err) {
    throw new ClientCommsVoiceError(
      `chat-service skill ${CLIENT_COMMS_SKILL_SLUG} unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ClientCommsVoiceError(
      `chat-service skill ${CLIENT_COMMS_SKILL_SLUG} unreadable: ${response.status} - ${text.slice(0, 300)}`
    );
  }
  const body = (await response.json()) as { content?: unknown };
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    throw new ClientCommsVoiceError(`chat-service skill ${CLIENT_COMMS_SKILL_SLUG} has no content`);
  }
  return content;
}

/** The voice as a system-prompt section. HOW only: it never changes what the prompt asks for. */
export function buildClientCommsVoiceDirective(voice: string): string {
  return [
    "",
    "OUR VOICE (how every message a person reads from us is written; follow it for HOW you write. WHAT you write, its facts and its ask, stays what the prompt, the instructions and the inputs say. Lines about tools or actions you do not have here do not apply to you):",
    "<<<",
    voice,
    ">>>",
  ].join("\n");
}
