import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts, threadGenerations } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { GenerateThreadRequestSchema, ThreadGenerationsQuerySchema, ThreadWriterRequestBodySchema } from "../schemas.js";
import { ChatModelCatalogueError, UnknownModelError } from "../lib/chat-model-catalogue.js";
import { buildThreadRequest, readThreadAnswer, ThreadInsufficientCreditsError, ThreadVariablesMissingError, writeThread } from "../lib/thread-writer.js";
import { readThreadGenerations } from "../lib/thread-generations-query.js";
import { decodeCursor } from "../lib/sequence-feed-query.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

/**
 * POST /generate-thread: ONE Threads thread (main post + replies) written with a stored template
 * (THREADS-IDEAS-AB). See src/lib/thread-writer.ts. The completion runs under the caller's run;
 * nothing is declared here.
 */
router.post("/generate-thread", (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next), async (req: AuthenticatedRequest, res) => {
  const parsed = GenerateThreadRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  const body = parsed.data;
  // Exactly one of `model` (this service writes) and `completion` (a script obtained it, ONE-WRITER-N-MODELS-1116-CG-THREAD-WA).
  if (body.completion && body.model) {
    return res.status(400).json({ error: "Send `model` or `completion`, not both: the model is the completion's", code: "MODEL_WITH_COMPLETION" });
  }
  if (!body.completion && !body.model) {
    return res.status(400).json({ error: "model: Required (or `completion`: the completion a script obtained)", code: "MODEL_REQUIRED" });
  }
  const brandIds = body.brandIds?.length ? body.brandIds : (req.brandIds ?? []);
  const campaignId = body.campaignId || req.campaignId || "";
  const workflowSlug = body.workflowSlug || req.workflowSlug;
  const featureSlug = body.featureSlug || req.featureSlug;

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
    const result = body.completion
      ? readHandedBack(params, body.completion)
      : await writeThread({ ...params, model: body.model! }, identity);
    const [row] = await db
      .insert(threadGenerations)
      .values({
        orgId: req.orgId!,
        runId: req.runId!,
        brandIds,
        campaignId,
        workflowSlug: workflowSlug ?? null,
        featureSlug: featureSlug ?? null,
        promptType: body.type,
        model: result.model,
        subject: result.subject,
        post: result.post,
        replies: result.replies,
        dryRun: body.dryRun === true,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        systemPromptRaw: result.systemPrompt,
        contextRaw: body.context,
        variablesRaw: body.variables,
        responseRaw: result.responseRaw,
      })
      .returning();

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-thread-done", detail: `id=${row.id} type=${body.type} model=${result.model} replies=${result.replies.length}${body.completion ? ` completion=handed back by run ${body.completion.runId}` : ""}` }, req.headers).catch(() => {});

    res.json({
      id: row.id,
      subject: result.subject,
      post: result.post,
      replies: result.replies,
      model: result.model,
      promptType: body.type,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    if (error instanceof ThreadVariablesMissingError) {
      return res.status(400).json({ error: error.message, code: error.code, missing: error.missing });
    }
    if (error instanceof UnknownModelError) {
      return res.status(400).json({ error: error.message, code: error.code, accepted: error.accepted });
    }
    if (error instanceof ThreadInsufficientCreditsError) {
      return res.status(402).json({ error: "Insufficient credits", balance_cents: error.balance_cents, required_cents: error.required_cents });
    }
    if (error instanceof ChatModelCatalogueError) {
      return res.status(502).json({ error: error.message, code: error.code });
    }
    console.error("[content-generation-service] generate-thread error:", error);
    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-thread-error", detail: error instanceof Error ? error.message : String(error), level: "error" }, req.headers).catch(() => {});
    res.status(502).json({ error: error instanceof Error ? error.message : "Thread generation failed" });
  }
});

/**
 * The thread a script's own completion wrote (ONE-WRITER-N-MODELS-1116-CG-THREAD-WA): read exactly as this service
 * reads its own answer; the system prompt stored is the one the completion was SENT with (the template is still
 * rendered first, so a missing token is the same 400).
 */
function readHandedBack(
  params: { type: string; promptTemplate: string; variables: Record<string, unknown>; context: string; brief?: string | null },
  completion: { request: Record<string, unknown>; answer: Record<string, unknown> },
) {
  const built = buildThreadRequest(params);
  const sent = typeof completion.request.systemPrompt === "string" ? completion.request.systemPrompt : built.systemPrompt;
  return readThreadAnswer(completion.answer, sent);
}

/**
 * POST /generate-thread/request (ONE-WRITER-N-MODELS-1116-CG-THREAD-WA): the chat-service request /generate-thread
 * would send, minus the LLM. A script asks workflow-service's LLM completion Engine with it, then hands the answer
 * back to POST /generate-thread as `completion`. Spends nothing, stores nothing.
 */
router.post("/generate-thread/request", (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next), async (req: AuthenticatedRequest, res) => {
  const parsed = ThreadWriterRequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  const body = parsed.data;
  try {
    const template = await db.query.prompts.findFirst({ where: eq(prompts.type, body.type) });
    if (!template) {
      return res.status(404).json({ error: `No template of type ${body.type}`, code: "TEMPLATE_NOT_FOUND" });
    }
    res.json({ request: buildThreadRequest({ type: body.type, promptTemplate: template.prompt, variables: body.variables, context: body.context, brief: body.brief }) });
  } catch (error) {
    if (error instanceof ThreadVariablesMissingError) {
      return res.status(400).json({ error: error.message, code: error.code, missing: error.missing });
    }
    console.error("[content-generation-service] generate-thread/request error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// Same settle as GET /internal/sequences: a row is stamped at insert START.
const SETTLE_SECONDS = 60;
const DEFAULT_LIMIT = 200;

/**
 * GET /internal/thread-generations (THREADS-IDEAS-AB): API key only, every org, oldest first. Each thread
 * written with a stored template: the run that wrote (and publishes) it, its template version + dynasty
 * and model. features-service credits each post's outcomes to the template and the LLM that wrote it.
 */
router.get("/internal/thread-generations", async (req: Request, res: Response) => {
  const parsed = ThreadGenerationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
  }
  const { since, cursor: rawCursor, limit } = parsed.data;
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return res.status(400).json({ error: "cursor is not a cursor issued by this service" });
  }
  try {
    res.json(await readThreadGenerations({ since, cursor, limit: limit ?? DEFAULT_LIMIT, settleSeconds: SETTLE_SECONDS }));
  } catch (error) {
    console.error(`[content-gen] GET /internal/thread-generations failed: ${(error as Error).message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
