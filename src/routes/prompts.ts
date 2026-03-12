import { Router } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { UpsertPromptRequestSchema } from "../schemas.js";

const router = Router();

/**
 * PUT /prompts — Upsert a prompt template for an org (idempotent)
 */
router.put("/prompts", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = UpsertPromptRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { type, prompt, variables } = parsed.data;

    // Upsert: insert or update on (orgId, type) conflict
    const existing = await db.query.prompts.findFirst({
      where: and(eq(prompts.orgId, req.orgId!), eq(prompts.type, type)),
    });

    let result;
    if (existing) {
      [result] = await db
        .update(prompts)
        .set({ prompt, variables, updatedAt: new Date() })
        .where(and(eq(prompts.orgId, req.orgId!), eq(prompts.type, type)))
        .returning();
    } else {
      [result] = await db
        .insert(prompts)
        .values({ orgId: req.orgId!, type, prompt, variables })
        .returning();
    }

    res.json({
      id: result.id,
      orgId: result.orgId,
      type: result.type,
      variables: result.variables,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("Upsert prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * GET /prompts?type — Get a stored prompt template
 */
router.get("/prompts", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { type } = req.query as { type?: string };

    if (!type) {
      return res.status(400).json({ error: "type query param required" });
    }

    const result = await db.query.prompts.findFirst({
      where: and(eq(prompts.orgId, req.orgId!), eq(prompts.type, type)),
    });

    if (!result) {
      return res.status(404).json({ error: `No prompt found for type=${type}` });
    }

    res.json({
      id: result.id,
      orgId: result.orgId,
      type: result.type,
      prompt: result.prompt,
      variables: result.variables,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("Get prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * PUT /platform-prompts — Upsert a platform-wide prompt template (idempotent)
 * Auth: API key only (no x-org-id, x-user-id, x-run-id required)
 * Platform prompts are used as fallback when an org has no prompt for a given type.
 */
router.put("/platform-prompts", async (req, res) => {
  try {
    const parsed = UpsertPromptRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { type, prompt, variables } = parsed.data;

    const existing = await db.query.prompts.findFirst({
      where: and(isNull(prompts.orgId), eq(prompts.type, type)),
    });

    let result;
    if (existing) {
      [result] = await db
        .update(prompts)
        .set({ prompt, variables, updatedAt: new Date() })
        .where(and(isNull(prompts.orgId), eq(prompts.type, type)))
        .returning();
    } else {
      [result] = await db
        .insert(prompts)
        .values({ orgId: null, type, prompt, variables })
        .returning();
    }

    res.json({
      id: result.id,
      type: result.type,
      variables: result.variables,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("Upsert platform prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
