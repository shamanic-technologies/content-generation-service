import { Router } from "express";
import { db } from "../db/index.js";
import { contentGenerations } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { generateContent } from "../lib/content-client.js";
import { generateCalendar } from "../lib/content-client.js";
import { decryptKey, type CallerContext } from "../lib/key-client.js";
import { createRun, updateRun, addCosts } from "../lib/runs-client.js";
import { GenerateContentRequestSchema, GenerateCalendarRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /generate/content — Generate email content from a free-text prompt
 */
router.post("/generate/content", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateContentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { prompt, variables, includeFooter, includeAiDisclaimer, workflowName } = parsed.data;

    // Get Anthropic API key
    const { key: apiKey, keySource } = await decryptKey("anthropic", req.orgId!, req.userId!, {
      callerMethod: "POST",
      callerPath: "/generate/content",
    });

    // Generate content
    const result = await generateContent(apiKey, { prompt, variables, includeFooter, includeAiDisclaimer });

    // Create run in runs-service — MUST succeed or we fail the request
    // x-run-id = incoming runId so runs-service sets it as parentRunId
    const genRun = await createRun({
      serviceName: "content-generation-service",
      taskName: "content-generation",
      workflowName,
    }, { orgId: req.orgId!, userId: req.userId!, runId: req.runId! });

    // Subsequent calls use genRun.id as x-run-id (the newly created run)
    const runIdentity = { orgId: req.orgId!, userId: req.userId!, runId: genRun.id };

    // Store in database
    const [generation] = await db
      .insert(contentGenerations)
      .values({
        orgId: req.orgId!,
        type: "email",
        prompt,
        variables: variables ?? null,
        includeFooter: includeFooter ?? false,
        subject: result.subject,
        bodyHtml: result.bodyHtml,
        bodyText: result.bodyText,
        generationRunId: genRun.id,
        workflowName: workflowName ?? null,
        model: "claude-sonnet-4-6",
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        promptRaw: result.promptRaw,
        responseRaw: result.responseRaw,
      })
      .returning();

    // Track costs — MUST succeed
    const costItems = [];
    if (result.tokensInput) {
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-input", quantity: result.tokensInput, costSource: keySource });
    }
    if (result.tokensOutput) {
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-output", quantity: result.tokensOutput, costSource: keySource });
    }
    if (costItems.length > 0) {
      await addCosts(genRun.id, costItems, runIdentity);
    }
    await updateRun(genRun.id, "completed", runIdentity);

    res.json({
      id: generation.id,
      subject: result.subject,
      bodyHtml: result.bodyHtml,
      bodyText: result.bodyText,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    console.error("[content] Generate content error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * POST /generate/calendar — Generate calendar event fields from a free-text prompt
 */
router.post("/generate/calendar", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateCalendarRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { prompt, workflowName } = parsed.data;

    // Get Anthropic API key
    const { key: apiKey, keySource } = await decryptKey("anthropic", req.orgId!, req.userId!, {
      callerMethod: "POST",
      callerPath: "/generate/calendar",
    });

    // Generate calendar fields
    const result = await generateCalendar(apiKey, { prompt });

    // Create run in runs-service — MUST succeed or we fail the request
    // x-run-id = incoming runId so runs-service sets it as parentRunId
    const genRun = await createRun({
      serviceName: "content-generation-service",
      taskName: "calendar-generation",
      workflowName,
    }, { orgId: req.orgId!, userId: req.userId!, runId: req.runId! });

    // Subsequent calls use genRun.id as x-run-id (the newly created run)
    const runIdentity = { orgId: req.orgId!, userId: req.userId!, runId: genRun.id };

    // Store in database
    const [generation] = await db
      .insert(contentGenerations)
      .values({
        orgId: req.orgId!,
        type: "calendar",
        prompt,
        title: result.title,
        description: result.description,
        location: result.location,
        generationRunId: genRun.id,
        workflowName: workflowName ?? null,
        model: "claude-sonnet-4-6",
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        promptRaw: result.promptRaw,
        responseRaw: result.responseRaw,
      })
      .returning();

    // Track costs — MUST succeed
    const costItems = [];
    if (result.tokensInput) {
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-input", quantity: result.tokensInput, costSource: keySource });
    }
    if (result.tokensOutput) {
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-output", quantity: result.tokensOutput, costSource: keySource });
    }
    if (costItems.length > 0) {
      await addCosts(genRun.id, costItems, runIdentity);
    }
    await updateRun(genRun.id, "completed", runIdentity);

    res.json({
      id: generation.id,
      title: result.title,
      description: result.description,
      location: result.location,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    console.error("[content] Generate calendar error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
