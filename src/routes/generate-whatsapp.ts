import { Router } from "express";
import type { z } from "zod";
import type { Tracking } from "../lib/tracking.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts, whatsappGenerations } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { GenerateWhatsAppRequestSchema, WhatsAppWriterRequestBodySchema } from "../schemas.js";
import { DEFAULT_MODEL } from "../lib/chat-models.js";
import { ChatModelCatalogueError, UnknownModelError } from "../lib/chat-model-catalogue.js";
import { ClientCommsVoiceError } from "../lib/client-comms-voice.js";
import { buildWhatsAppRequest, readWhatsAppAnswer, renderWhatsAppTemplate, WhatsAppInsufficientCreditsError, WhatsAppVariablesMissingError, writeWhatsApp, type WhatsAppWriteResult } from "../lib/whatsapp-writer.js";
import { traceEvent } from "../lib/trace-event.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { messageWrittenDeclaration } from "../lib/run-outcomes.js";
import { messageFromStep } from "../lib/pipe-from-step.js";
import { declareStoredOutcomes } from "../lib/outcome-declarations.js";

const router = Router();

/**
 * POST /generate-whatsapp — ONE WhatsApp message, as its bubbles, written with a stored template
 * (WA-TEMPLATES-1023). See src/lib/whatsapp-writer.ts.
 */
router.post("/generate-whatsapp", (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next), async (req: AuthenticatedRequest, res) => {
  const parsed = GenerateWhatsAppRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  const body = parsed.data;
  // `completion` = a script obtained the completion itself (ONE-WRITER-N-MODELS-1116-CG-THREAD-WA): never beside a model.
  if (body.completion && body.model) {
    return res.status(400).json({ error: "Send `model` or `completion`, not both: the model is the completion's", code: "MODEL_WITH_COMPLETION" });
  }
  const brandIds = body.brandIds?.length ? body.brandIds : (req.brandIds ?? []);
  const campaignId = body.campaignId || req.campaignId || "";
  const workflowSlug = body.workflowSlug || req.workflowSlug;
  const featureSlug = body.featureSlug || req.featureSlug;
  const model = body.model ?? DEFAULT_MODEL;

  try {
    const template = await db.query.prompts.findFirst({ where: eq(prompts.type, body.type) });
    if (!template) {
      return res.status(404).json({ error: `No template of type ${body.type}`, code: "TEMPLATE_NOT_FOUND" });
    }

    const identity = {
      orgId: req.orgId!,
      userId: req.userId!,
      runId: req.runId!,
      campaignId: campaignId || undefined,
      brandId: brandIds.length ? brandIds.join(",") : req.brandId,
      workflowSlug,
      featureSlug,
      audienceId: req.audienceId,
    };
    const params = { type: body.type, promptTemplate: template.prompt, variables: body.variables, context: body.context, brief: body.brief };
    if (body.completion) {
      // A completion the script obtained: the message is declared on the run that asked it (its completion run is
      // that run's child), exactly as the email a script writes is declared on the script's run. No run of ours.
      renderWhatsAppTemplate(body.type, template.prompt, body.variables);
      const sent = body.completion.request.systemPrompt;
      const systemPrompt = typeof sent === "string" ? sent : (await buildWhatsAppRequest(params)).systemPrompt;
      const result = readWhatsAppAnswer(body.completion.answer, systemPrompt);
      return res.json(await storeWhatsApp(req, body, { brandIds, campaignId, workflowSlug, featureSlug, identity }, result, body.completion.runId));
    }

    // This service's run for the writing call, opened BEFORE the completion so chat-service's
    // `/complete` run (and its cost) is its child; a message written declares `message_written`
    // on it (COST-ACCOUNTING-1023-P1). Never blocks the message: a runs-service refusal leaves
    // the completion under the caller's run, as before, and nothing is declared (logged loud).
    let generationRunId: string | null = null;
    try {
      const run = await createRun(
        { brandId: identity.brandId, campaignId: identity.campaignId, serviceName: "content-generation-service", taskName: "whatsapp-generation", workflowSlug },
        identity,
      );
      generationRunId = run.id;
    } catch (err) {
      console.error("[content-gen] RUN TRACKING FAILED (whatsapp).", { runId: req.runId, error: err instanceof Error ? err.message : err });
    }
    const finishRun = async (status: "completed" | "failed") => {
      if (!generationRunId) return;
      try {
        await updateRun(generationRunId, status, { ...identity, runId: generationRunId });
      } catch (err) {
        console.error("[content-gen] RUN TRACKING FAILED (whatsapp).", { runId: req.runId, generationRunId, error: err instanceof Error ? err.message : err });
      }
    };

    let result: Awaited<ReturnType<typeof writeWhatsApp>>;
    try {
      result = await writeWhatsApp({ ...params, model }, { ...identity, runId: generationRunId ?? identity.runId });
    } catch (err) {
      await finishRun("failed");
      throw err;
    }
    const answer = await storeWhatsApp(req, body, { brandIds, campaignId, workflowSlug, featureSlug, identity }, result, generationRunId, finishRun);
    res.json(answer);
  } catch (error) {
    if (error instanceof WhatsAppVariablesMissingError) {
      return res.status(400).json({ error: error.message, code: error.code, missing: error.missing });
    }
    if (error instanceof UnknownModelError) {
      return res.status(400).json({ error: error.message, code: error.code, accepted: error.accepted });
    }
    if (error instanceof WhatsAppInsufficientCreditsError) {
      return res.status(402).json({ error: "Insufficient credits", balance_cents: error.balance_cents, required_cents: error.required_cents });
    }
    if (error instanceof ChatModelCatalogueError) {
      return res.status(502).json({ error: error.message, code: error.code });
    }
    if (error instanceof ClientCommsVoiceError) {
      return res.status(502).json({ error: error.message, code: "CLIENT_COMMS_UNAVAILABLE" });
    }
    console.error("[content-generation-service] generate-whatsapp error:", error);
    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-whatsapp-error", detail: error instanceof Error ? error.message : String(error), level: "error" }, req.headers).catch(() => {});
    res.status(502).json({ error: error instanceof Error ? error.message : "WhatsApp generation failed" });
  }
});

type WhatsAppBody = z.infer<typeof GenerateWhatsAppRequestSchema>;
interface WhatsAppScope {
  brandIds: string[];
  campaignId: string;
  workflowSlug: string | undefined;
  featureSlug: string | undefined;
  identity: Tracking & { runId: string };
}

/**
 * Stores one completion and answers it: the same row, the same `message_written` declaration (on
 * `generationRunId`: this service's run, or the run that asked a handed-back completion), the same answer.
 */
async function storeWhatsApp(
  req: AuthenticatedRequest,
  body: WhatsAppBody,
  { brandIds, campaignId, workflowSlug, featureSlug, identity }: WhatsAppScope,
  result: WhatsAppWriteResult,
  generationRunId: string | null,
  finishRun?: (status: "completed" | "failed") => Promise<void>,
) {
    // Only a message actually written for a person is an outcome; later/stop write nothing.
    // The step this message's pipe starts from is what it consumes (PIPE-FROM-STEP-1024).
    const writes = generationRunId && result.decision === "write";
    const pipeFrom = writes && body.leadId ? await messageFromStep(campaignId, identity) : null;
    const outcomes = writes
      ? messageWrittenDeclaration({ leadId: body.leadId, variables: body.variables, pipeFromStep: pipeFrom?.known ? pipeFrom.fromStep : null })
      : null;
    if (generationRunId && result.decision === "write" && !outcomes) {
      console.warn(`[content-gen] WhatsApp message written without a leadId: no outcome declared (run=${generationRunId})`);
    }

    const [row] = await db
      .insert(whatsappGenerations)
      .values({
        orgId: req.orgId!,
        runId: req.runId!,
        brandIds,
        campaignId,
        leadId: body.leadId ?? null,
        workflowSlug: workflowSlug ?? null,
        featureSlug: featureSlug ?? null,
        promptType: body.type,
        model: result.model,
        decision: result.decision,
        bubbles: result.bubbles,
        reason: result.reason,
        nextFollowUpAt: result.nextFollowUpAt,
        nextFollowUpWhy: result.nextFollowUpWhy,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        systemPromptRaw: result.systemPrompt,
        contextRaw: body.context,
        variablesRaw: body.variables,
        responseRaw: result.responseRaw,
        generationRunId,
        outcomes,
      })
      .returning();
    if (finishRun) await finishRun("completed");
    if (outcomes) void declareStoredOutcomes("whatsapp_generations", row.id);

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-whatsapp-done", detail: `id=${row.id} type=${body.type} model=${result.model} decision=${result.decision} bubbles=${result.bubbles.length}` }, req.headers).catch(() => {});

    return {
      id: row.id,
      decision: result.decision,
      bubbles: result.bubbles,
      message: result.bubbles.join("\n\n"),
      reason: result.reason,
      nextFollowUpAt: result.nextFollowUpAt,
      nextFollowUpWhy: result.nextFollowUpWhy,
      model: result.model,
      promptType: body.type,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    };
}

/**
 * POST /generate-whatsapp/request (ONE-WRITER-N-MODELS-1116-CG-THREAD-WA): the chat-service request
 * /generate-whatsapp would send, minus the LLM. A script asks workflow-service's LLM completion Engine with it, then
 * hands the answer back to POST /generate-whatsapp as `completion`. Reads our voice; spends nothing, stores nothing.
 */
router.post("/generate-whatsapp/request", (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next), async (req: AuthenticatedRequest, res) => {
  const parsed = WhatsAppWriterRequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  const body = parsed.data;
  try {
    const template = await db.query.prompts.findFirst({ where: eq(prompts.type, body.type) });
    if (!template) {
      return res.status(404).json({ error: `No template of type ${body.type}`, code: "TEMPLATE_NOT_FOUND" });
    }
    res.json({ request: await buildWhatsAppRequest({ type: body.type, promptTemplate: template.prompt, variables: body.variables, context: body.context, brief: body.brief }) });
  } catch (error) {
    if (error instanceof WhatsAppVariablesMissingError) {
      return res.status(400).json({ error: error.message, code: error.code, missing: error.missing });
    }
    if (error instanceof ClientCommsVoiceError) {
      return res.status(502).json({ error: error.message, code: "CLIENT_COMMS_UNAVAILABLE" });
    }
    console.error("[content-generation-service] generate-whatsapp/request error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
