import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts, whatsappGenerations } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { GenerateWhatsAppRequestSchema } from "../schemas.js";
import { DEFAULT_MODEL } from "../lib/chat-models.js";
import { ChatModelCatalogueError, UnknownModelError } from "../lib/chat-model-catalogue.js";
import { ClientCommsVoiceError } from "../lib/client-comms-voice.js";
import { WhatsAppInsufficientCreditsError, WhatsAppVariablesMissingError, writeWhatsApp } from "../lib/whatsapp-writer.js";
import { traceEvent } from "../lib/trace-event.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { messageWrittenDeclaration } from "../lib/run-outcomes.js";
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
      result = await writeWhatsApp(
        { type: body.type, promptTemplate: template.prompt, variables: body.variables, context: body.context, model },
        { ...identity, runId: generationRunId ?? identity.runId },
      );
    } catch (err) {
      await finishRun("failed");
      throw err;
    }
    // Only a message actually written for a person is an outcome; later/stop write nothing.
    const outcomes =
      generationRunId && result.decision === "write"
        ? messageWrittenDeclaration({ leadId: body.leadId, variables: body.variables })
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
    await finishRun("completed");
    if (outcomes) void declareStoredOutcomes("whatsapp_generations", row.id);

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-whatsapp-done", detail: `id=${row.id} type=${body.type} model=${result.model} decision=${result.decision} bubbles=${result.bubbles.length}` }, req.headers).catch(() => {});

    res.json({
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
    });
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

export default router;
