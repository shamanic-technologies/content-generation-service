import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts, threadGenerations } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { GenerateThreadRequestSchema, ThreadGenerationsQuerySchema } from "../schemas.js";
import { ChatModelCatalogueError, UnknownModelError } from "../lib/chat-model-catalogue.js";
import { ThreadInsufficientCreditsError, ThreadVariablesMissingError, writeThread } from "../lib/thread-writer.js";
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
    const result = await writeThread(
      { type: body.type, promptTemplate: template.prompt, variables: body.variables, context: body.context, model: body.model },
      identity,
    );
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
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        systemPromptRaw: result.systemPrompt,
        contextRaw: body.context,
        variablesRaw: body.variables,
        responseRaw: result.responseRaw,
      })
      .returning();

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-thread-done", detail: `id=${row.id} type=${body.type} model=${result.model} replies=${result.replies.length}` }, req.headers).catch(() => {});

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
