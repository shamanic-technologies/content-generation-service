import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { CreatePromptRequestSchema, VersionPromptRequestSchema } from "../schemas.js";
import { createPromptVersion } from "../lib/prompt-versioning.js";
import { LEAD_CONTEXT_VARIABLES_PUBLISHED } from "../lib/lead-context-variables.js";
import { assertTemplateNeutral } from "../lib/template-neutrality-guard.js";
import { templateWriteErrorResponse } from "../lib/template-neutrality.js";
import type { JudgmentCaller } from "../lib/judgments-client.js";
import { extractTracking } from "../lib/tracking.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPromptResponse(row: typeof prompts.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    variables: row.variables,
    // Optional lead + organization inputs every template accepts, whether or not
    // its body declares a {{token}} for them. Published here so a caller builds
    // its variable mapping from the live contract rather than from a document.
    contextVariables: LEAD_CONTEXT_VARIABLES_PUBLISHED,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Org-billed neutrality judgment under the inbound identity (serviceAuth guarantees runId). */
function orgCaller(req: AuthenticatedRequest): JudgmentCaller {
  return { mode: "org", tracking: { ...extractTracking(req), runId: req.runId! } };
}

// ---------------------------------------------------------------------------
// GET /prompts?type= — Read a prompt (with identity headers)
// ---------------------------------------------------------------------------
router.get("/prompts", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { type } = req.query as { type?: string };
    if (!type) {
      return res.status(400).json({ error: "type query param required" });
    }

    const result = await db.query.prompts.findFirst({
      where: eq(prompts.type, type),
    });

    if (!result) {
      return res.status(404).json({ error: `No prompt found for type=${type}` });
    }

    res.json(formatPromptResponse(result));
  } catch (error) {
    console.error("Get prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /platform-prompts?type= — Read a prompt (no identity headers)
// ---------------------------------------------------------------------------
router.get("/platform-prompts", async (req, res) => {
  try {
    const { type } = req.query as { type?: string };
    if (!type) {
      return res.status(400).json({ error: "type query param required" });
    }

    const result = await db.query.prompts.findFirst({
      where: eq(prompts.type, type),
    });

    if (!result) {
      return res.status(404).json({ error: `No prompt found for type=${type}` });
    }

    res.json(formatPromptResponse(result));
  } catch (error) {
    console.error("Get platform prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /prompts — Idempotent create (with identity headers)
// ---------------------------------------------------------------------------
router.post("/prompts", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = CreatePromptRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { type, prompt, variables } = parsed.data;

    const existing = await db.query.prompts.findFirst({
      where: eq(prompts.type, type),
    });

    if (existing) {
      return res.status(200).json(formatPromptResponse(existing));
    }

    await assertTemplateNeutral({ prompt, variables, caller: orgCaller(req) });

    const [result] = await db
      .insert(prompts)
      .values({ orgId: req.orgId!, type, prompt, variables })
      .returning();

    res.status(201).json(formatPromptResponse(result));
  } catch (error) {
    const refused = templateWriteErrorResponse(error);
    if (refused) return res.status(refused.status).json(refused.body);
    console.error("Create prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /platform-prompts — Idempotent create (no identity headers)
// ---------------------------------------------------------------------------
router.post("/platform-prompts", async (req, res) => {
  try {
    const parsed = CreatePromptRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { type, prompt, variables } = parsed.data;

    const existing = await db.query.prompts.findFirst({
      where: eq(prompts.type, type),
    });

    if (existing) {
      return res.status(200).json(formatPromptResponse(existing));
    }

    await assertTemplateNeutral({ prompt, variables, caller: { mode: "platform" } });

    const [result] = await db
      .insert(prompts)
      .values({ orgId: null, type, prompt, variables })
      .returning();

    res.status(201).json(formatPromptResponse(result));
  } catch (error) {
    const refused = templateWriteErrorResponse(error);
    if (refused) return res.status(refused.status).json(refused.body);
    console.error("Create platform prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /prompts — Create new versioned prompt (with identity headers)
// ---------------------------------------------------------------------------
router.put("/prompts", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = VersionPromptRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { sourceType, prompt, variables } = parsed.data;

    const { row, created } = await createPromptVersion({
      sourceType,
      prompt,
      variables,
      orgId: req.orgId!,
      neutralityCaller: orgCaller(req),
    });

    res.status(created ? 201 : 200).json(formatPromptResponse(row));
  } catch (error) {
    const refused = templateWriteErrorResponse(error);
    if (refused) return res.status(refused.status).json(refused.body);
    console.error("Version prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
