import { Router } from "express";
import { eq, and, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { generateFromTemplate, substituteVariables, findUnfilledPlaceholders } from "../lib/anthropic-client.js";
import { decryptKey } from "../lib/key-client.js";
import { createRun, updateRun, addCosts } from "../lib/runs-client.js";
import { authorizeCredits, ESTIMATED_INPUT_TOKENS, ESTIMATED_OUTPUT_TOKENS } from "../lib/billing-client.js";
import { getCampaignFeatureInputs } from "../lib/campaign-client.js";
import { extractBrandFields } from "../lib/brand-client.js";
import { GenerateRequestSchema, StatsRequestSchema, StatsQuerySchema } from "../schemas.js";

const router = Router();

/**
 * POST /generate — Generate content using a stored prompt template + variables
 */
router.post("/generate", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const {
      type,
      variables,
      brandId: bodyBrandId,
      campaignId: bodyCampaignId,
      apolloEnrichmentId,
      leadId,
      idempotencyKey,
      workflowName: bodyWorkflowName,
      featureSlug: bodyFeatureSlug,
      includeAiDisclaimer,
    } = parsed.data;

    // Header values (from workflow-service) serve as fallback when body values are missing
    const brandId = bodyBrandId || req.brandId;
    const campaignId = bodyCampaignId || req.campaignId;
    const workflowName = bodyWorkflowName || req.workflowName;
    const featureSlug = bodyFeatureSlug || req.featureSlug;

    // Idempotency: return existing generation if key matches
    if (idempotencyKey) {
      const existing = await db.query.emailGenerations.findFirst({
        where: and(
          eq(emailGenerations.orgId, req.orgId!),
          eq(emailGenerations.idempotencyKey, idempotencyKey)
        ),
      });

      if (existing) {
        return res.json({
          id: existing.id,
          subject: existing.subject ?? "",
          sequence: existing.sequence ?? [],
          tokensInput: existing.tokensInput ?? 0,
          tokensOutput: existing.tokensOutput ?? 0,
        });
      }
    }

    // Look up the stored prompt by type (globally unique)
    const storedPrompt = await db.query.prompts.findFirst({
      where: eq(prompts.type, type),
    });

    if (!storedPrompt) {
      return res.status(404).json({
        error: `No prompt found for type=${type}. Register one via POST /prompts or POST /platform-prompts first.`,
      });
    }

    // Get Anthropic API key
    const caller = { callerMethod: "POST", callerPath: "/generate", campaignId, brandId, workflowName, featureSlug };
    const { key: anthropicApiKey, keySource } = await decryptKey("anthropic", req.orgId!, req.userId!, caller);

    // Convention 2: fetch campaign featureInputs for LLM context enrichment
    const serviceIdentity = { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowName, featureSlug };
    let campaignContext: Record<string, unknown> | null = null;
    if (campaignId) {
      try {
        campaignContext = await getCampaignFeatureInputs(campaignId, serviceIdentity);
      } catch (err) {
        console.warn("[content-gen] Failed to fetch campaign context — proceeding without it.", err instanceof Error ? err.message : err);
      }
    }

    // Convention 1: resolve unfilled template variables from Brand Service
    if (brandId && storedPrompt.prompt) {
      try {
        const afterSubstitution = substituteVariables(storedPrompt.prompt, variables);
        const unfilled = findUnfilledPlaceholders(afterSubstitution);
        if (unfilled.length > 0) {
          const fields = unfilled.map((key) => ({
            key,
            description: `Value for the "${key}" field needed in content generation`,
          }));
          const brandValues = await extractBrandFields(brandId, fields, serviceIdentity);
          for (const [key, value] of brandValues) {
            variables[key] = value;
          }
        }
      } catch (err) {
        console.warn("[content-gen] Failed to resolve brand fields — proceeding with available variables.", err instanceof Error ? err.message : err);
      }
    }

    // Billing gate: authorize credits before platform-paid operations
    if (keySource === "platform") {
      const { sufficient, balance_cents, required_cents } = await authorizeCredits(
        [
          { costName: "anthropic-sonnet-4.6-tokens-input", quantity: ESTIMATED_INPUT_TOKENS },
          { costName: "anthropic-sonnet-4.6-tokens-output", quantity: ESTIMATED_OUTPUT_TOKENS },
        ],
        "content-generation — claude-sonnet-4-6",
        { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowName, featureSlug }
      );
      if (!sufficient) {
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents,
          required_cents,
        });
      }
    }

    // Generate using the stored prompt + variable substitution + campaign context
    const result = await generateFromTemplate(anthropicApiKey, {
      promptTemplate: storedPrompt.prompt,
      variables,
      includeAiDisclaimer,
      campaignContext,
    });

    // Extract lead/client fields from variables for dedicated columns
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;

    // Store in database
    const [generation] = await db
      .insert(emailGenerations)
      .values({
        orgId: req.orgId!,
        runId: req.runId!,
        apolloEnrichmentId: apolloEnrichmentId ?? null,
        promptType: type,
        brandId: brandId ?? "",
        campaignId: campaignId ?? "",
        variablesRaw: variables,
        // Populate dedicated lead/client columns from variables
        leadFirstName: str(variables.leadFirstName),
        leadLastName: str(variables.leadLastName),
        leadTitle: str(variables.leadTitle),
        leadCompany: str(variables.leadCompanyName),
        leadIndustry: str(variables.leadCompanyIndustry),
        clientCompanyName: str(variables.clientCompanyName),
        subject: result.subject,
        sequence: result.sequence,
        model: "claude-sonnet-4-6",
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        promptRaw: result.promptRaw,
        responseRaw: result.responseRaw,
        workflowName: workflowName ?? null,
        featureSlug: featureSlug ?? null,
        leadId: leadId ?? null,
        idempotencyKey: idempotencyKey ?? null,
      })
      .returning();

    // Track run + costs in runs-service
    try {
      // x-run-id = incoming runId so runs-service sets it as parentRunId
      const genRun = await createRun({
        brandId,
        campaignId,
        serviceName: "content-generation-service",
        taskName: "single-generation",
        workflowName,
      }, { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowName, featureSlug });

      // Link generation run to email record IMMEDIATELY so per-item cost
      // lookups work even if addCosts/updateRun fail below
      await db.update(emailGenerations)
        .set({ generationRunId: genRun.id })
        .where(eq(emailGenerations.id, generation.id));

      // Subsequent calls use genRun.id as x-run-id (the newly created run)
      const runIdentity = { orgId: req.orgId!, userId: req.userId!, runId: genRun.id, campaignId, brandId, workflowName, featureSlug };

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
    } catch (err) {
      console.error("[content-gen] COST TRACKING FAILED — costs will be missing from campaign totals.", {
        runId: req.runId,
        apolloEnrichmentId,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        costNames: ["anthropic-sonnet-4.6-tokens-input", "anthropic-sonnet-4.6-tokens-output"],
        error: err instanceof Error ? err.message : err,
      });
    }

    res.json({
      id: generation.id,
      subject: result.subject,
      sequence: result.sequence,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    console.error("Generate error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * GET /generations - List generations with filters
 * Query params: runId, campaignId, brandId (at least one required)
 */
router.get("/generations", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, campaignId, brandId } = req.query as {
      runId?: string;
      campaignId?: string;
      brandId?: string;
    };

    if (!runId && !campaignId && !brandId) {
      return res.status(400).json({ error: "At least one filter required: runId, campaignId, or brandId" });
    }

    const conditions: SQL[] = [eq(emailGenerations.orgId, req.orgId!)];
    if (runId) conditions.push(eq(emailGenerations.runId, runId));
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));
    if (brandId) conditions.push(eq(emailGenerations.brandId, brandId));

    const generations = await db.query.emailGenerations.findMany({
      where: and(...conditions),
      orderBy: (gens, { desc }) => [desc(gens.createdAt)],
    });

    res.json({ generations });
  } catch (error) {
    console.error("List generations error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /generations/by-enrichment/:apolloEnrichmentId - Get generation by enrichment ID
 */
router.get("/generations/by-enrichment/:apolloEnrichmentId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloEnrichmentId } = req.params;

    const generation = await db.query.emailGenerations.findFirst({
      where: (gens, { eq, and }) =>
        and(
          eq(gens.apolloEnrichmentId, apolloEnrichmentId),
          eq(gens.orgId, req.orgId!)
        ),
    });

    if (!generation) {
      return res.status(404).json({ error: "Generation not found" });
    }

    res.json({ generation });
  } catch (error) {
    console.error("Get generation error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /generations/by-lead/:leadId - Get generation by lead-service correlation ID
 */
router.get("/generations/by-lead/:leadId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { leadId } = req.params;

    const generation = await db.query.emailGenerations.findFirst({
      where: (gens, { eq, and }) =>
        and(
          eq(gens.leadId, leadId),
          eq(gens.orgId, req.orgId!)
        ),
    });

    if (!generation) {
      return res.status(404).json({ error: "Generation not found" });
    }

    res.json({ generation });
  } catch (error) {
    console.error("Get generation by leadId error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /stats - Get aggregated stats with query-param filters + optional groupBy
 */
router.get("/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = StatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { campaignId, brandId, orgId, runIds, groupBy } = parsed.data;

    if (!campaignId && !brandId && !orgId && !runIds) {
      return res.status(400).json({ error: "At least one filter required: campaignId, brandId, orgId, or runIds" });
    }

    const conditions: SQL[] = [];
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));
    if (brandId) conditions.push(eq(emailGenerations.brandId, brandId));
    if (orgId) conditions.push(eq(emailGenerations.orgId, orgId));
    if (runIds) {
      const ids = runIds.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) conditions.push(inArray(emailGenerations.runId, ids));
    }

    if (groupBy === "campaignId") {
      const results = await db
        .select({
          key: emailGenerations.campaignId,
          emailsGenerated: sql<number>`count(*)::int`,
        })
        .from(emailGenerations)
        .where(and(...conditions))
        .groupBy(emailGenerations.campaignId);

      return res.json({
        groups: results.map((r) => ({
          key: r.key,
          stats: { emailsGenerated: r.emailsGenerated },
        })),
      });
    }

    if (groupBy === "model") {
      const results = await db
        .select({
          key: emailGenerations.model,
          emailsGenerated: sql<number>`count(*)::int`,
        })
        .from(emailGenerations)
        .where(and(...conditions))
        .groupBy(emailGenerations.model);

      return res.json({
        groups: results.map((r) => ({
          key: r.key,
          stats: { emailsGenerated: r.emailsGenerated },
        })),
      });
    }

    // No groupBy — flat stats
    const results = await db
      .select({
        emailsGenerated: sql<number>`count(*)::int`,
      })
      .from(emailGenerations)
      .where(and(...conditions));

    res.json({
      stats: { emailsGenerated: results[0]?.emailsGenerated ?? 0 },
    });
  } catch (error) {
    console.error("GET /stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /stats - Get aggregated stats for multiple run IDs
 * @deprecated Use GET /stats with query params instead
 */
router.post("/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = StatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { runIds, brandId, campaignId } = parsed.data;

    const hasRunIds = Array.isArray(runIds) && runIds.length > 0;

    if (!hasRunIds && !brandId && !campaignId) {
      return res.status(400).json({ error: "At least one filter required: runIds, brandId, or campaignId" });
    }

    const conditions: SQL[] = [
      eq(emailGenerations.orgId, req.orgId!),
    ];
    if (hasRunIds) conditions.push(inArray(emailGenerations.runId, runIds!));
    if (brandId) conditions.push(eq(emailGenerations.brandId, brandId));
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));

    // Count email generations
    const generations = await db.query.emailGenerations.findMany({
      where: and(...conditions),
      columns: { id: true },
    });

    res.json({
      stats: {
        emailsGenerated: generations.length,
      },
    });
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
