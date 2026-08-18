import { Router, type Response, type NextFunction } from "express";
import { eq, and, inArray, arrayContains, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, prompts } from "../db/schema.js";
import { serviceAuth, serviceAuthRunOptional, AuthenticatedRequest } from "../middleware/auth.js";
import { generateFromTemplate, generateExpertQuotePitchFromTemplate, substituteVariables, findUnfilledPlaceholders, InsufficientCreditsError, ExpertQuotePitchLengthError } from "../lib/chat-service-client.js";
import { resolveAssignedPromptType } from "../lib/prompt-assignment.js";
import { assertExpertQuotePitchVariables, ExpertQuotePitchInputError } from "../lib/expert-quote-pitch-template.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { getCampaignFeatureInputs } from "../lib/campaign-client.js";
import { extractBrandFields, resolveBrandNames } from "../lib/brand-client.js";
import { fetchWorkflowExamples, toExampleEmail } from "../lib/examples-query.js";
import { GenerateRequestSchema, GenerateExpertQuotePitchRequestSchema, StatsRequestSchema, StatsQuerySchema } from "../schemas.js";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../lib/dynasty-client.js";
import { traceEvent } from "../lib/trace-event.js";

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
      model,
      brandIds: bodyBrandIds,
      campaignId: bodyCampaignId,
      apolloEnrichmentId,
      leadId,
      idempotencyKey,
      workflowSlug: bodyWorkflowName,
      featureSlug: bodyFeatureSlug,
      audienceId: bodyAudienceId,
    } = parsed.data;

    // Header values (from workflow-service) serve as fallback when body values are missing
    const brandIds = bodyBrandIds?.length ? bodyBrandIds : (req.brandIds ?? []);
    // Raw CSV string for identity forwarding to downstream services
    const brandId = brandIds.length > 0 ? brandIds.join(",") : req.brandId;
    const campaignId = bodyCampaignId || req.campaignId;
    const workflowSlug = bodyWorkflowName || req.workflowSlug;
    const featureSlug = bodyFeatureSlug || req.featureSlug;
    const audienceId = bodyAudienceId || req.audienceId;

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-start", detail: `type=${type}, brandIds=${brandIds.join(",")}, campaignId=${campaignId ?? "none"}, idempotencyKey=${idempotencyKey ?? "none"}` }, req.headers).catch(() => {});

    // Idempotency: return existing generation if key matches
    if (idempotencyKey) {
      const existing = await db.query.emailGenerations.findFirst({
        where: and(
          eq(emailGenerations.orgId, req.orgId!),
          eq(emailGenerations.idempotencyKey, idempotencyKey)
        ),
      });

      if (existing) {
        traceEvent(req.runId!, { service: "content-generation-service", event: "idempotency-hit", detail: `Returning cached generation id=${existing.id} for key=${idempotencyKey}` }, req.headers).catch(() => {});
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

    traceEvent(req.runId!, { service: "content-generation-service", event: "prompt-resolved", detail: `Loaded stored prompt type=${type}, promptId=${storedPrompt.id ?? "unknown"}` }, req.headers).catch(() => {});

    // Convention 2: fetch campaign featureInputs for LLM context enrichment
    const serviceIdentity = { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowSlug, featureSlug, audienceId };
    let campaignContext: Record<string, unknown> | null = null;
    if (campaignId) {
      campaignContext = await getCampaignFeatureInputs(campaignId, serviceIdentity);
    }

    // Convention 1: resolve unfilled template variables from Brand Service
    if (brandIds.length > 0 && storedPrompt.prompt) {
      try {
        const afterSubstitution = substituteVariables(storedPrompt.prompt, variables);
        const unfilled = findUnfilledPlaceholders(afterSubstitution);
        if (unfilled.length > 0) {
          traceEvent(req.runId!, { service: "content-generation-service", event: "brand-extract", detail: `Extracting ${unfilled.length} unfilled fields from brand-service: ${unfilled.join(", ")}`, data: { brandIds, fields: unfilled } }, req.headers).catch(() => {});
          const fields = unfilled.map((key) => ({
            key,
            description: `Value for the "${key}" field needed in content generation`,
          }));
          const brandValues = await extractBrandFields(fields, serviceIdentity);
          for (const [key, value] of brandValues) {
            variables[key] = value;
          }
        }
      } catch (err) {
        console.warn("[content-gen] Failed to resolve brand fields — proceeding with available variables.", err instanceof Error ? err.message : err);
      }
    }

    // Generate using the stored prompt + variable substitution + campaign context
    // Chat-service handles key resolution, billing, and cost tracking internally
    traceEvent(req.runId!, { service: "content-generation-service", event: "llm-call-start", detail: `Calling chat-service with prompt type=${type}, variableCount=${Object.keys(variables).length}, hasCampaignContext=${!!campaignContext}` }, req.headers).catch(() => {});
    const result = await generateFromTemplate(
      {
        promptTemplate: storedPrompt.prompt,
        variables,
        campaignContext,
        model,
      },
      { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowSlug, featureSlug, audienceId }
    );

    traceEvent(req.runId!, { service: "content-generation-service", event: "llm-call-done", detail: `model=${result.model}, tokensIn=${result.tokensInput}, tokensOut=${result.tokensOutput}, sequenceLen=${result.sequence?.length ?? 0}`, data: { model: result.model, tokensInput: result.tokensInput, tokensOutput: result.tokensOutput } }, req.headers).catch(() => {});

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
        brandIds: brandIds,
        campaignId: campaignId ?? "",
        variablesRaw: variables,
        // Populate dedicated lead/client columns from variables
        leadFirstName: str(variables.leadFirstName),
        leadLastName: str(variables.leadLastName),
        leadTitle: str(variables.leadTitle),
        leadCompany: str(variables.leadCompanyName),
        leadIndustry: str(variables.leadCompanyIndustry),
        leadOrganizationDomain: str(variables.organizationDomain),
        clientCompanyName: str(variables.clientCompanyName),
        subject: result.subject,
        sequence: result.sequence,
        model: result.model,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        promptRaw: result.promptRaw,
        responseRaw: result.responseRaw,
        workflowSlug: workflowSlug ?? null,
        featureSlug: featureSlug ?? null,
        audienceId: audienceId ?? null,
        leadId: leadId ?? null,
        idempotencyKey: idempotencyKey ?? null,
      })
      .returning();

    // Track run in runs-service (cost tracking is handled by chat-service)
    try {
      const genRun = await createRun({
        brandId,
        campaignId,
        serviceName: "content-generation-service",
        taskName: "single-generation",
        workflowSlug,
      }, { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowSlug, featureSlug, audienceId });

      // Link generation run to email record
      await db.update(emailGenerations)
        .set({ generationRunId: genRun.id })
        .where(eq(emailGenerations.id, generation.id));

      const runIdentity = { orgId: req.orgId!, userId: req.userId!, runId: genRun.id, campaignId, brandId, workflowSlug, featureSlug, audienceId };
      await updateRun(genRun.id, "completed", runIdentity);
    } catch (err) {
      console.error("[content-gen] RUN TRACKING FAILED.", {
        runId: req.runId,
        apolloEnrichmentId,
        error: err instanceof Error ? err.message : err,
      });
    }

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-done", detail: `generationId=${generation.id}, subject="${result.subject?.slice(0, 60) ?? ""}"` }, req.headers).catch(() => {});

    res.json({
      id: generation.id,
      subject: result.subject,
      sequence: result.sequence,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return res.status(402).json({
        error: "Insufficient credits",
        balance_cents: error.balance_cents,
        required_cents: error.required_cents,
      });
    }
    console.error("Generate error:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "content-generation-service", event: "generate-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

const PITCH_MIN_CHARS = 100;
const PITCH_MAX_CHARS = 2500;

/**
 * POST /generate-expert-quote-pitch — Generate a journalist-quote pitch (Featured.com).
 * Loads the stored `expert-quote-pitch` template, substitutes brand + request
 * inputs, and enforces a 100-2500 char output range with one retry on miss.
 */
router.post("/generate-expert-quote-pitch", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateExpertQuotePitchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { variables, templateType, model, brandIds: bodyBrandIds, campaignId: bodyCampaignId, workflowSlug: bodyWorkflowSlug, featureSlug: bodyFeatureSlug, audienceId: bodyAudienceId } = parsed.data;

    const brandIds = bodyBrandIds?.length ? bodyBrandIds : (req.brandIds ?? []);
    const brandId = brandIds.length > 0 ? brandIds.join(",") : req.brandId;
    const campaignId = bodyCampaignId || req.campaignId;
    const workflowSlug = bodyWorkflowSlug || req.workflowSlug;
    const featureSlug = bodyFeatureSlug || req.featureSlug;
    const audienceId = bodyAudienceId || req.audienceId;

    // Resolution order: explicit templateType ▸ feature assignment ▸ platform default.
    const resolvedType = templateType ?? (await resolveAssignedPromptType(featureSlug));

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-expert-quote-pitch-start", detail: `brandIds=${brandIds.join(",")}, variableCount=${Object.keys(variables).length}, promptType=${resolvedType}` }, req.headers).catch(() => {});

    const storedPrompt = await db.query.prompts.findFirst({
      where: eq(prompts.type, resolvedType),
    });

    if (!storedPrompt) {
      return res.status(404).json({
        error: `No prompt found for type=${resolvedType}. Service should register it at boot via POST /platform-prompts.`,
      });
    }

    // Explicit, all-required input contract — fail loud (400) before spending an
    // LLM call when a declared variable is missing or a brand object is incomplete.
    try {
      assertExpertQuotePitchVariables(
        variables,
        (storedPrompt.variables as Array<{ name: string }>) ?? []
      );
    } catch (validationError) {
      if (validationError instanceof ExpertQuotePitchInputError) {
        return res.status(400).json({ error: validationError.message });
      }
      throw validationError;
    }

    const identity = { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowSlug, featureSlug, audienceId };

    const result = await generateExpertQuotePitchFromTemplate(
      {
        promptTemplate: storedPrompt.prompt,
        variables,
        minChars: PITCH_MIN_CHARS,
        maxChars: PITCH_MAX_CHARS,
        model,
      },
      identity
    );

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-expert-quote-pitch-done", detail: `chars=${result.charCount}, attempts=${result.attempts}, model=${result.model}` }, req.headers).catch(() => {});

    res.json({
      pitch: result.pitch,
      charCount: result.charCount,
      attempts: result.attempts,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    if (error instanceof ExpertQuotePitchLengthError) {
      traceEvent(req.runId!, { service: "content-generation-service", event: "generate-expert-quote-pitch-length-violation", detail: `chars=${error.charCount}, range=[${error.minChars},${error.maxChars}], attempts=${error.attempts}`, level: "warn" }, req.headers).catch(() => {});
      return res.status(400).json({
        error: `Generated pitch length ${error.charCount} chars is outside the required range [${error.minChars}, ${error.maxChars}] after ${error.attempts} attempts.`,
        charCount: error.charCount,
        minChars: error.minChars,
        maxChars: error.maxChars,
        attempts: error.attempts,
      });
    }
    if (error instanceof InsufficientCreditsError) {
      return res.status(402).json({
        error: "Insufficient credits",
        balance_cents: error.balance_cents,
        required_cents: error.required_cents,
      });
    }
    console.error("[content-generation-service] /generate-expert-quote-pitch error:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "content-generation-service", event: "generate-expert-quote-pitch-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * Hard ceiling on how many generation rows one GET /generations response may carry.
 *
 * A generation row carries the full prompt, the raw model response and the whole
 * sequence — production averages ~52 KB per row, and a single brand holds >10,000
 * of them (~542 MB of row text, several times that once it is JS objects plus one
 * JSON string). That read had no bound at all and is what exhausted the V8 heap.
 * 2,000 rows is ~100 MB of row text, which every observed campaign and brand read
 * that completed successfully stays under.
 */
export const MAX_GENERATIONS_PER_RESPONSE = 2000;

/** Parse a non-negative integer query param. `undefined` when absent, `null` when malformed. */
function parseCount(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * GET /generations - List generations with filters
 * Query params: runId, campaignId, brandId (at least one required), limit, offset
 *
 * Bounded: an explicit `limit` (1..MAX_GENERATIONS_PER_RESPONSE) pages the result.
 * Without one, a result set larger than the ceiling is refused with 413 naming the
 * ceiling — never trimmed silently, so a caller can never mistake a partial list
 * for the whole one.
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

    const limit = parseCount(req.query.limit as string | undefined);
    const offset = parseCount(req.query.offset as string | undefined);

    if (limit === null || (limit !== undefined && (limit < 1 || limit > MAX_GENERATIONS_PER_RESPONSE))) {
      return res.status(400).json({
        error: `limit must be an integer between 1 and ${MAX_GENERATIONS_PER_RESPONSE}`,
      });
    }
    if (offset === null) {
      return res.status(400).json({ error: "offset must be a non-negative integer" });
    }

    const conditions: SQL[] = [eq(emailGenerations.orgId, req.orgId!)];
    if (runId) conditions.push(eq(emailGenerations.runId, runId));
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));
    if (brandId) conditions.push(arrayContains(emailGenerations.brandIds, [brandId]));

    // Without an explicit limit, read one row past the ceiling: its presence is the
    // signal that the unpaginated result set does not fit, and the read itself stays
    // bounded either way.
    const paginated = limit !== undefined;
    const fetchLimit = paginated ? limit : MAX_GENERATIONS_PER_RESPONSE + 1;

    const generations = await db.query.emailGenerations.findMany({
      where: and(...conditions),
      orderBy: (gens, { desc }) => [desc(gens.createdAt)],
      limit: fetchLimit,
      offset: offset ?? 0,
    });

    if (!paginated && generations.length > MAX_GENERATIONS_PER_RESPONSE) {
      console.error(
        `[content-generation-service] GET /generations refused: over ${MAX_GENERATIONS_PER_RESPONSE} rows ` +
          `(org=${req.orgId}, runId=${runId ?? "-"}, campaignId=${campaignId ?? "-"}, brandId=${brandId ?? "-"})`
      );
      return res.status(413).json({
        error:
          `This filter matches more than ${MAX_GENERATIONS_PER_RESPONSE} generations, which is too large to return ` +
          `in one response. Narrow the filter, or page through it with limit (max ${MAX_GENERATIONS_PER_RESPONSE}) and offset.`,
        maxGenerations: MAX_GENERATIONS_PER_RESPONSE,
      });
    }

    res.json({ generations });
  } catch (error) {
    console.error("List generations error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /generations/examples - Gold-layer cascade of example emails for a workflow.
 * Query: workflowSlug (required), brandId (required), limit (default 3).
 * Cascade brand -> org -> global over the silver view; each row tagged scope + brandName.
 * Uses serviceAuthRunOptional: a default workflow-picker load has org+user but no run context.
 */
router.get(
  "/generations/examples",
  // Wrapped (not passed directly) so this module stays import-safe under unit tests that fully
  // mock src/middleware/auth.js without the newer serviceAuthRunOptional export: the binding is
  // read at request time, not at route-registration (module-eval) time.
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => serviceAuthRunOptional(req, res, next),
  async (req: AuthenticatedRequest, res) => {
  try {
    const { workflowSlug, brandId } = req.query as {
      workflowSlug?: string;
      brandId?: string;
      limit?: string;
    };

    if (!workflowSlug) {
      return res.status(400).json({ error: "workflowSlug query param required" });
    }
    if (!brandId) {
      return res.status(400).json({ error: "brandId query param required" });
    }

    // Default 3 (contract); honor a caller-supplied positive limit, no silent ceiling.
    const parsedLimit = parseInt((req.query.limit as string | undefined) ?? "", 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 3;

    const rows = await fetchWorkflowExamples({
      callerOrgId: req.orgId!,
      brandId,
      workflowSlug,
      limit,
    });

    // brandName enrichment for org/global tiers — best-effort batch lookup, null acceptable.
    const sourceBrandIds = rows
      .filter((r) => r.scope !== "brand")
      .map((r) => r.brandIds[0])
      .filter((id): id is string => Boolean(id));
    const brandNames = await resolveBrandNames(sourceBrandIds);

    const examples = rows.map((r) => toExampleEmail(r, brandNames));
    res.json({ examples });
  } catch (error) {
    console.error("[content-generation-service] List workflow examples error:", error);
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
 *
 * Optional `?brandId=<uuid>` scopes the read to the brand being viewed. A single
 * person (lead) contacted by multiple brands in the same org has one generation per
 * brand; without a brand scope this read is ambiguous and can return the wrong
 * brand's email. When `brandId` is provided, return that brand's generation for the
 * lead (most recent if several). When absent, behavior is unchanged (backward-compatible).
 */
router.get("/generations/by-lead/:leadId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { leadId } = req.params;
    const { brandId } = req.query as { brandId?: string };

    const conditions: SQL[] = [
      eq(emailGenerations.leadId, leadId),
      eq(emailGenerations.orgId, req.orgId!),
    ];
    if (brandId) conditions.push(arrayContains(emailGenerations.brandIds, [brandId]));

    // Order by newest only in the brand-scoped path (deterministic "most recent"
    // when a brand has several generations for the lead). Unscoped path stays
    // byte-unchanged: no orderBy, same single-condition WHERE as before.
    const generation = brandId
      ? await db.query.emailGenerations.findFirst({
          where: and(...conditions),
          orderBy: (gens, { desc }) => [desc(gens.createdAt)],
        })
      : await db.query.emailGenerations.findFirst({
          where: and(...conditions),
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

    const {
      campaignId, brandId, orgId, runIds,
      workflowSlug, featureSlug,
      workflowDynastySlug, featureDynastySlug,
      groupBy,
    } = parsed.data;

    if (!campaignId && !brandId && !orgId && !runIds) {
      return res.status(400).json({ error: "At least one filter required: campaignId, brandId, orgId, or runIds" });
    }

    // Resolve dynasty slugs into versioned slug lists
    let resolvedWorkflowSlugs: string[] | undefined;
    if (workflowDynastySlug) {
      resolvedWorkflowSlugs = await resolveWorkflowDynastySlugs(workflowDynastySlug);
      if (resolvedWorkflowSlugs.length === 0) {
        // Dynasty resolved to nothing — return zero stats
        return res.json(groupBy ? { groups: [] } : { stats: { emailsGenerated: 0 } });
      }
    }

    let resolvedFeatureSlugs: string[] | undefined;
    if (featureDynastySlug) {
      resolvedFeatureSlugs = await resolveFeatureDynastySlugs(featureDynastySlug);
      if (resolvedFeatureSlugs.length === 0) {
        return res.json(groupBy ? { groups: [] } : { stats: { emailsGenerated: 0 } });
      }
    }

    // Build conditions — dynasty slug (resolved list) takes priority over exact slug
    const conditions: SQL[] = [];
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));
    if (brandId) conditions.push(arrayContains(emailGenerations.brandIds, [brandId]));
    if (orgId) conditions.push(eq(emailGenerations.orgId, orgId));
    if (runIds) {
      const ids = runIds.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) conditions.push(inArray(emailGenerations.runId, ids));
    }

    if (resolvedWorkflowSlugs && resolvedWorkflowSlugs.length > 0) {
      conditions.push(inArray(emailGenerations.workflowSlug, resolvedWorkflowSlugs));
    } else if (workflowSlug) {
      conditions.push(eq(emailGenerations.workflowSlug, workflowSlug));
    }

    if (resolvedFeatureSlugs && resolvedFeatureSlugs.length > 0) {
      conditions.push(inArray(emailGenerations.featureSlug, resolvedFeatureSlugs));
    } else if (featureSlug) {
      conditions.push(eq(emailGenerations.featureSlug, featureSlug));
    }

    // --- GroupBy: exact slug ---
    if (groupBy === "campaignId" || groupBy === "model" || groupBy === "workflowSlug" || groupBy === "featureSlug") {
      const col = groupBy === "campaignId" ? emailGenerations.campaignId
        : groupBy === "model" ? emailGenerations.model
        : groupBy === "workflowSlug" ? emailGenerations.workflowSlug
        : emailGenerations.featureSlug;

      const results = await db
        .select({
          key: col,
          emailsGenerated: sql<number>`count(*)::int`,
        })
        .from(emailGenerations)
        .where(and(...conditions))
        .groupBy(col);

      return res.json({
        groups: results.map((r) => ({
          key: r.key,
          stats: { emailsGenerated: r.emailsGenerated },
        })),
      });
    }

    // --- GroupBy: dynasty slug (aggregate versioned slugs into dynasty) ---
    if (groupBy === "workflowDynastySlug" || groupBy === "featureDynastySlug") {
      const isWorkflow = groupBy === "workflowDynastySlug";
      const col = isWorkflow ? emailGenerations.workflowSlug : emailGenerations.featureSlug;
      const dynastyMap = isWorkflow
        ? await getWorkflowDynastyMap()
        : await getFeatureDynastyMap();

      const results = await db
        .select({
          key: col,
          emailsGenerated: sql<number>`count(*)::int`,
        })
        .from(emailGenerations)
        .where(and(...conditions))
        .groupBy(col);

      // Aggregate rows by dynasty slug using the reverse map
      const aggregated = new Map<string, number>();
      for (const r of results) {
        const dynastyKey = (r.key ? dynastyMap.get(r.key) : null) ?? r.key;
        aggregated.set(dynastyKey ?? "", (aggregated.get(dynastyKey ?? "") ?? 0) + r.emailsGenerated);
      }

      return res.json({
        groups: Array.from(aggregated.entries()).map(([key, count]) => ({
          key: key || null,
          stats: { emailsGenerated: count },
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
    console.error("[content-generation-service] GET /stats error:", error);
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
    if (brandId) conditions.push(arrayContains(emailGenerations.brandIds, [brandId]));
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));

    // Count in SQL. Reading every matching row back only to take its length grew
    // the response-side memory with the org's whole history for no gain.
    const results = await db
      .select({ emailsGenerated: sql<number>`count(*)::int` })
      .from(emailGenerations)
      .where(and(...conditions));

    res.json({
      stats: {
        emailsGenerated: results[0]?.emailsGenerated ?? 0,
      },
    });
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
