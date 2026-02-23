import { Router } from "express";
import { db } from "../db/index.js";
import { contentGenerations } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { generateContent } from "../lib/content-client.js";
import { generateCalendar } from "../lib/content-client.js";
import { getByokKey, getAppKey } from "../lib/key-client.js";
import { createRun, updateRun, addCosts } from "../lib/runs-client.js";
import { GenerateContentRequestSchema, GenerateCalendarRequestSchema } from "../schemas.js";

const router = Router();

/**
 * Resolve the Anthropic API key based on keyMode.
 */
async function resolveApiKey(
  keyMode: "byok" | "app",
  clerkOrgId: string,
  appId: string
): Promise<string> {
  if (keyMode === "byok") {
    return getByokKey(clerkOrgId, "anthropic");
  }
  return getAppKey(appId, "anthropic");
}

/**
 * POST /generate/content — Generate email content from a free-text prompt
 */
router.post("/generate/content", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateContentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { appId, prompt, variables, includeFooter, includeAiDisclaimer, keyMode, parentRunId, workflowName } = parsed.data;

    // Get Anthropic API key
    const apiKey = await resolveApiKey(keyMode, req.clerkOrgId!, appId);

    // Generate content
    const result = await generateContent(apiKey, { prompt, variables, includeFooter, includeAiDisclaimer });

    // Create run in runs-service — MUST succeed or we fail the request
    const genRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId,
      serviceName: "content-generation-service",
      taskName: "content-generation",
      parentRunId,
      workflowName,
    });

    // Store in database
    const [generation] = await db
      .insert(contentGenerations)
      .values({
        orgId: req.orgId!,
        appId,
        type: "email",
        keyMode,
        prompt,
        variables: variables ?? null,
        includeFooter: includeFooter ?? false,
        subject: result.subject,
        bodyHtml: result.bodyHtml,
        bodyText: result.bodyText,
        generationRunId: genRun.id,
        parentRunId: parentRunId ?? null,
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
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-input", quantity: result.tokensInput });
    }
    if (result.tokensOutput) {
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-output", quantity: result.tokensOutput });
    }
    if (costItems.length > 0) {
      await addCosts(genRun.id, costItems);
    }
    await updateRun(genRun.id, "completed");

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

    const { appId, prompt, keyMode, parentRunId, workflowName } = parsed.data;

    // Get Anthropic API key
    const apiKey = await resolveApiKey(keyMode, req.clerkOrgId!, appId);

    // Generate calendar fields
    const result = await generateCalendar(apiKey, { prompt });

    // Create run in runs-service — MUST succeed or we fail the request
    const genRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId,
      serviceName: "content-generation-service",
      taskName: "calendar-generation",
      parentRunId,
      workflowName,
    });

    // Store in database
    const [generation] = await db
      .insert(contentGenerations)
      .values({
        orgId: req.orgId!,
        appId,
        type: "calendar",
        keyMode,
        prompt,
        title: result.title,
        description: result.description,
        location: result.location,
        generationRunId: genRun.id,
        parentRunId: parentRunId ?? null,
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
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-input", quantity: result.tokensInput });
    }
    if (result.tokensOutput) {
      costItems.push({ costName: "anthropic-sonnet-4.6-tokens-output", quantity: result.tokensOutput });
    }
    if (costItems.length > 0) {
      await addCosts(genRun.id, costItems);
    }
    await updateRun(genRun.id, "completed");

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
