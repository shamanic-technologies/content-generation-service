import { Router } from "express";
import { eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { CreatePromptRequestSchema, VersionPromptRequestSchema } from "../schemas.js";

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

/**
 * Find the next available versioned type name.
 * "cold-email" → "cold-email-v2"
 * "cold-email-v5" → "cold-email-v6"
 * If "cold-email-v2" already exists, keeps incrementing until a free slot is found.
 */
async function findNextVersionType(sourceType: string): Promise<string> {
  const match = sourceType.match(/^(.+)-v(\d+)$/);
  const baseName = match ? match[1] : sourceType;

  const existing = await db.query.prompts.findMany({
    where: like(prompts.type, `${baseName}-v%`),
    columns: { type: true },
  });

  let maxVersion = 1; // base type counts as v1
  for (const p of existing) {
    const m = p.type.match(/-v(\d+)$/);
    if (m) {
      maxVersion = Math.max(maxVersion, parseInt(m[1], 10));
    }
  }

  return `${baseName}-v${maxVersion + 1}`;
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

    // If sourceType doesn't exist yet, create it directly with that type
    const source = await db.query.prompts.findFirst({
      where: eq(prompts.type, sourceType),
    });

    // If source exists and content is identical, return it as-is (no new version)
    if (
      source &&
      source.prompt === prompt &&
      JSON.stringify(source.variables) === JSON.stringify(variables)
    ) {
      return res.status(200).json(formatPromptResponse(source));
    }

    const newType = source ? await findNextVersionType(sourceType) : sourceType;

    const [result] = await db
      .insert(prompts)
      .values({ orgId: req.orgId!, type: newType, prompt, variables })
      .returning();

    res.status(201).json(formatPromptResponse(result));
  } catch (error) {
    console.error("Version prompt error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
