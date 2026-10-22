/**
 * The "why this sentence" report of the signed-out preview, made by a SECOND completion
 * that reads the FINISHED first email. The writing completion is the exact call a real
 * /generate run makes (owner 2026-10-16: the model is trusted, the writing call is never
 * touched): asking it to also annotate changed how it wrote (5 of 36 previews came back
 * as one block with no line breaks, 0 of 31 campaign emails on the same template + model).
 *
 * This call never alters the email: it only reports, per sentence, which offered input
 * it rests on. Its output is validated by `resolveHighlights` (preview-highlights.ts).
 * Billing is chat-service's, under the same identity headers as the writing call.
 */
import type { ChatModel } from "./chat-models.js";
import { resolveChatModel } from "./chat-model-catalogue.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import type { HighlightSource, RawHighlight } from "./preview-highlights.js";

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || "";

/** Copying sentences verbatim and naming one input each: Sonnet 5.5, strict schema. */
export const PREVIEW_ANNOTATE_MODEL: ChatModel = "claude-sonnet";

export const ANNOTATE_SYSTEM_PROMPT = [
  "You explain an email that has already been written. You never rewrite it.",
  "",
  "You receive the email body and the inputs its writer was given. For every sentence of the body after the greeting, in order, report which ONE input it rests on.",
  '- "text": copied VERBATIM from the email body (same characters, same punctuation), never paraphrased. One sentence, or one clause of it.',
  '- "source": the id of the ONE input this text rests on. Use a data input when the text states or builds on that fact; use "instruction" only when the text exists because a writing rule asked for it (a greeting, a diagnostic question, the call to action) and no input produced it.',
  '- "reason": one short plain-English sentence saying why this text is there, naming the fact or the rule. Never claim a fact that is not in the input you name.',
  'Return ONLY a JSON object: {"highlights": [{"text": "...", "source": "...", "reason": "..."}]}.',
].join("\n");

export function buildAnnotateMessage(bodyText: string, sources: ReadonlyArray<HighlightSource>): string {
  return [
    "Inputs the writer was given (id: what it is = its value):",
    ...sources.map((s) => `- ${s.id}: ${s.label}${s.value === null ? "" : ` = ${s.value}`}`),
    "",
    "The email body:",
    "<<<",
    bodyText,
    ">>>",
  ].join("\n");
}

function annotateSchema(sourceIds: string[], strict: boolean): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: "object",
    properties: {
      text: { type: "string" },
      source: { type: "string", enum: sourceIds },
      reason: { type: "string" },
    },
    required: ["text", "source", "reason"],
  };
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { highlights: { type: "array", items: item } },
    required: ["highlights"],
  };
  if (strict) {
    item.additionalProperties = false;
    schema.additionalProperties = false;
  }
  return schema;
}

/**
 * One completion; throws on any failure. The caller decides what a failure means (the
 * preview is served without highlights, never blocked).
 */
export async function annotatePreviewEmail(
  input: { bodyText: string; sources: ReadonlyArray<HighlightSource> },
  identity: Tracking & { runId: string }
): Promise<{ highlights: RawHighlight[]; tokensInput: number; tokensOutput: number; model: string }> {
  const model = PREVIEW_ANNOTATE_MODEL;
  const { provider } = await resolveChatModel(model);
  const response = await fetchWithRetry(
    `${CHAT_SERVICE_URL}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": CHAT_SERVICE_API_KEY,
        ...buildTrackingHeaders(identity),
      },
      body: JSON.stringify({
        message: buildAnnotateMessage(input.bodyText, input.sources),
        systemPrompt: ANNOTATE_SYSTEM_PROMPT,
        responseSchema: annotateSchema(input.sources.map((s) => s.id), provider === "anthropic"),
        provider,
        model,
      }),
    },
    { label: "chat-service /complete (preview annotate)" }
  );
  if (!response.ok) {
    throw new Error(`chat-service /complete failed for provider '${provider}' model '${model}' (preview annotate): ${response.status} - ${await response.text()}`);
  }
  const data = (await response.json()) as { json?: { highlights?: unknown }; tokensInput?: number; tokensOutput?: number; model: string };
  const raw = data.json?.highlights;
  if (!Array.isArray(raw)) {
    throw new Error(`preview annotate: chat-service answered without a highlights array (model ${data.model})`);
  }
  return {
    highlights: raw.filter((h): h is RawHighlight => h !== null && typeof h === "object"),
    tokensInput: data.tokensInput ?? 0,
    tokensOutput: data.tokensOutput ?? 0,
    model: data.model,
  };
}
