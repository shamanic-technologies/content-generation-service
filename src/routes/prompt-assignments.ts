import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts, featurePromptAssignment } from "../db/schema.js";
import { serviceAuthRunOptional, AuthenticatedRequest } from "../middleware/auth.js";
import { PutPromptAssignmentRequestSchema } from "../schemas.js";
import {
  resolveAssignedPromptType,
  assertPromptVariablesMatch,
  PromptVariableMismatchError,
  PLATFORM_DEFAULT_PROMPT_TYPE,
} from "../lib/prompt-assignment.js";
import { createPromptVersion } from "../lib/prompt-versioning.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /prompt-assignments?featureSlug= — Read the currently-resolved prompt for a feature
// ---------------------------------------------------------------------------
router.get("/prompt-assignments", serviceAuthRunOptional, async (req: AuthenticatedRequest, res) => {
  try {
    const { featureSlug } = req.query as { featureSlug?: string };
    if (!featureSlug) {
      return res.status(400).json({ error: "featureSlug query param required" });
    }

    const promptType = await resolveAssignedPromptType(featureSlug);

    const row = await db.query.prompts.findFirst({
      where: eq(prompts.type, promptType),
    });

    if (!row) {
      return res.status(404).json({
        error: `No prompt found for resolved type=${promptType}. Service should register the platform default at boot.`,
      });
    }

    res.json({
      featureSlug,
      promptType,
      prompt: row.prompt,
      variables: row.variables,
      isDefault: promptType === PLATFORM_DEFAULT_PROMPT_TYPE,
    });
  } catch (error) {
    console.error("[content-generation-service] Get prompt assignment error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /prompt-assignments — Fork the resolved prompt + reassign the feature to the fork
// ---------------------------------------------------------------------------
router.put("/prompt-assignments", serviceAuthRunOptional, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = PutPromptAssignmentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { featureSlug, prompt, variables } = parsed.data;

    // Resolve the currently-assigned (or default) type — this is the fork source.
    const sourceType = await resolveAssignedPromptType(featureSlug);

    const source = await db.query.prompts.findFirst({
      where: eq(prompts.type, sourceType),
    });

    if (!source) {
      return res.status(404).json({
        error: `No prompt found for resolved type=${sourceType}. Service should register the platform default at boot.`,
      });
    }

    // Integrity guard: submitted {{var}} tokens MUST exactly match the source's
    // declared variable-name set. Throws → 400; nothing forked, nothing assigned.
    assertPromptVariablesMatch(prompt, sourceType, source.variables);

    // Fork (reuses the auto-version logic; source row is never mutated).
    const { row } = await createPromptVersion({
      sourceType,
      prompt,
      variables,
      orgId: req.orgId!,
    });

    // Reassign the feature to the forked type.
    await db
      .insert(featurePromptAssignment)
      .values({ featureSlug, promptType: row.type })
      .onConflictDoUpdate({
        target: featurePromptAssignment.featureSlug,
        set: { promptType: row.type, updatedAt: new Date() },
      });

    res.json({
      featureSlug,
      promptType: row.type,
      prompt: row.prompt,
      variables: row.variables,
    });
  } catch (error) {
    if (error instanceof PromptVariableMismatchError) {
      return res.status(400).json({ error: error.message });
    }
    console.error("[content-generation-service] Put prompt assignment error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
