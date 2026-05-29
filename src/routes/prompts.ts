import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { CreatePromptRequestSchema, VersionPromptRequestSchema } from "../schemas.js";
import { createPromptVersion } from "../lib/prompt-versioning.js";

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

    const [result] = await db
      .insert(prompts)
      .values({ orgId: req.orgId!, type, prompt, variables })
      .returning();

    res.status(201).json(formatPromptResponse(result));
  } catch (error) {
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

    const [result] = await db
      .insert(prompts)
      .values({ orgId: null, type, prompt, variables })
      .returning();

    res.status(201).json(formatPromptResponse(result));
  } catch (error) {
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
    });

    res.status(created ? 201 : 200).json(formatPromptResponse(row));
  } catch (error) {
    console.error("Version prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
