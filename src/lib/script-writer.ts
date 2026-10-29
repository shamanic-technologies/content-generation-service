/**
 * FACTORY-P3 fleet writer switch (owner 2026-10-29, « 3.B »): the cold email of every workflow is WRITTEN by
 * workflow-service's stored script `message_written/dy_template_writer_full` (its own sandbox, its own run, our
 * chat-service door), and everything this service did around the LLM call stays here, unchanged:
 *
 *   POST /generate/materials   everything `/generate` did BEFORE the completion (idempotency and one-email-per-lead
 *                              hits, the stored template, campaign context, unfilled brand fields, the recipient's
 *                              language, the offer's give lists, the campaign's instruction, the asked LLM and its
 *                              provider), answered as the script step's materials (`units`), `tactics` and `subject`;
 *   POST /generate + `written` everything `/generate` did AFTER the completion: the `email_generations` row (prompt_raw,
 *                              response_raw, chat_request + chat_request_inputs, tokens, model, generation_run_id =
 *                              the script's run) and the ONE `message_written` declaration, made by this service's
 *                              never-lost machinery on the script's run (the script run declares nothing: it is
 *                              started with `recordedBy: "content-generation"`).
 *
 * Pure helpers (no I/O): the units the script reads and the row values read back from its run.
 */
import type { OfferGiveLists } from "./offer-give-lists.js";

/** The stored script that writes the fleet's cold emails. */
export const SCRIPT_WRITER = { outcome: "message_written", dynasty: "dy_template_writer_full" } as const;

export interface WriterMaterialsInput {
  promptTemplate: string;
  /** The request's variables after unfilled brand fields were resolved. */
  variables: Record<string, unknown>;
  campaignContext: Record<string, unknown> | null;
  language: string | null;
  giveLists: OfferGiveLists | null;
  instruction: string | null;
}

/**
 * The script's materials, in the step runner's shape (`{content}` per outcome), split exactly as the recorded cases
 * that proved the script were (`lead*` variables on the person, every other variable on the brand).
 */
export function writerUnits(m: WriterMaterialsInput) {
  const lead: Record<string, unknown> = {};
  const brand: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.variables)) (k.startsWith("lead") ? lead : brand)[k] = v;
  return {
    lead_identified: { content: { variables: lead, ...(m.language ? { language: m.language } : {}) } },
    brand_context: {
      content: {
        variables: brand,
        ...(m.campaignContext ? { campaignContext: m.campaignContext } : {}),
        ...(m.giveLists ? { giveLists: m.giveLists } : {}),
        ...(m.instruction ? { instruction: m.instruction } : {}),
      },
    },
    template_written: { content: { text: m.promptTemplate } },
  };
}

export class WrittenByScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrittenByScriptError";
  }
}

interface TraceEntry {
  name?: unknown;
  sent?: unknown;
  answer?: unknown;
  raw?: unknown;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * What the script wrote and how, read off its run (`POST /orgs/scripts/run` answer with `trace: true`) and the
 * materials it was handed. Throws `WrittenByScriptError` (400) when the run is not a made message with its traced
 * completion: a row is never stored from a guess.
 */
export function readWrittenByScript(written: unknown, units: unknown) {
  const w = obj(written);
  if (!w) throw new WrittenByScriptError("written: the script run's answer is required");
  if (w.status !== "made") throw new WrittenByScriptError(`written: the script run made nothing (status ${String(w.status)})`);
  const runId = typeof w.runId === "string" && w.runId ? w.runId : null;
  if (!runId) throw new WrittenByScriptError("written: the script run names no runId");
  const content = obj(obj(w.unit)?.content);
  const subject = content?.subject;
  const sequence = content?.sequence;
  if (typeof subject !== "string" || !Array.isArray(sequence)) throw new WrittenByScriptError("written: the unit carries no subject and sequence");
  const trace = Array.isArray(w.trace) ? (w.trace as TraceEntry[]) : [];
  const completions = trace.filter((t) => t?.name === "llm.complete");
  if (completions.length !== 1) throw new WrittenByScriptError(`written: expected exactly one traced llm.complete, found ${completions.length}`);
  const sent = obj(completions[0].sent);
  const raw = obj(completions[0].raw);
  if (!sent || !raw) throw new WrittenByScriptError("written: the traced completion carries no request or answer");
  const voice = obj(obj(trace.find((t) => t?.name === "voice.read")?.answer)?.data)?.content;
  if (typeof voice !== "string" || !voice) throw new WrittenByScriptError("written: the traced voice.read carries no voice");

  const u = obj(units);
  const leadUnit = obj(obj(u?.lead_identified)?.content);
  const brandUnit = obj(obj(u?.brand_context)?.content);
  const template = obj(obj(u?.template_written)?.content)?.text;
  if (!leadUnit || !brandUnit || typeof template !== "string") throw new WrittenByScriptError("materials: the units the script was handed are required");

  return {
    runId,
    subject,
    sequence,
    model: typeof raw.model === "string" ? raw.model : null,
    tokensInput: Number(raw.tokensInput ?? 0),
    tokensOutput: Number(raw.tokensOutput ?? 0),
    promptRaw: String(sent.message ?? ""),
    responseRaw: raw,
    // content-generation's own key order: { message, systemPrompt, responseSchema, provider, model }.
    chatRequest: { message: sent.message, systemPrompt: sent.systemPrompt, responseSchema: sent.responseSchema, provider: sent.provider, model: sent.model },
    chatRequestInputs: {
      promptTemplate: template,
      campaignContext: (obj(brandUnit.campaignContext) ?? null) as Record<string, unknown> | null,
      language: typeof leadUnit.language === "string" ? leadUnit.language : null,
      giveLists: (obj(brandUnit.giveLists) ?? null) as OfferGiveLists | null,
      instruction: typeof brandUnit.instruction === "string" ? brandUnit.instruction : null,
      clientCommsVoice: voice,
    },
    variables: { ...(obj(leadUnit.variables) ?? {}), ...(obj(brandUnit.variables) ?? {}) },
  };
}
