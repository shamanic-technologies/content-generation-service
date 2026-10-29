import { normalizeInstruction } from "../lib/campaign-instruction.js";
import { Router, type Response, type NextFunction } from "express";
import type { z } from "zod";
import { WrittenByScriptError, readWrittenByScript, writerUnits } from "../lib/script-writer.js";
import { DEFAULT_MODEL } from "../lib/chat-models.js";
import { eq, and, inArray, arrayContains, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, prompts } from "../db/schema.js";
import { serviceAuth, serviceAuthRunOptional, AuthenticatedRequest } from "../middleware/auth.js";
import { unfilledBrandFieldRequests } from "../lib/unfilled-brand-fields.js";
import { generateFromTemplate, generateExpertQuotePitchFromTemplate, substituteVariables, findUnfilledPlaceholders, InsufficientCreditsError, ExpertQuotePitchLengthError } from "../lib/chat-service-client.js";
import { resolveAssignedPromptType } from "../lib/prompt-assignment.js";
import { assertExpertQuotePitchVariables, ExpertQuotePitchInputError } from "../lib/expert-quote-pitch-template.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { messageWrittenDeclaration, LEAD_SUBJECT_SERVICE } from "../lib/run-outcomes.js";
import { messageFromStep } from "../lib/pipe-from-step.js";
import { declareStoredOutcomes } from "../lib/outcome-declarations.js";
import { getCampaignFeatureInputs } from "../lib/campaign-client.js";
import { extractBrandFields, resolveBrandNames } from "../lib/brand-client.js";
import { fetchOfferGiveLists } from "../lib/offer-give-lists-client.js";
import { type OfferGiveLists, hasGiveLists } from "../lib/offer-give-lists.js";
import { fetchWorkflowExamples, toExampleEmail } from "../lib/examples-query.js";
import { getLeadBusinessLanguages } from "../lib/lead-client.js";
import { resolveLeadLanguage } from "../lib/lead-language.js";
import { GenerateRequestSchema, GenerateExpertQuotePitchRequestSchema, StatsRequestSchema, StatsQuerySchema } from "../schemas.js";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../lib/dynasty-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { findGenerationForLead } from "../lib/lead-generation-query.js";
import { withResolvedBody } from "../lib/generation-body.js";
import { RECORDED_REQUEST_COLUMNS_OFF } from "../lib/recorded-request.js";
import { withSequenceDelays, IncompleteSequenceError } from "../lib/sequence-delays.js";
import { ClientCommsVoiceError } from "../lib/client-comms-voice.js";
import { ChatModelCatalogueError, UnknownModelError, resolveChatModel } from "../lib/chat-model-catalogue.js";
import { stripDashes, hasDashes } from "../lib/dashes.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { textToHtml } from "../lib/text-to-html.js";

const router = Router();

/**
 * The `/generate` response body. Shared by the fresh-generation path and by both
 * paths that answer with a stored generation (idempotency key, existing lead email),
 * so a caller cannot tell them apart and needs no branching.
 *
 * `tokensInput`/`tokensOutput` on a stored generation are the ORIGINAL completion's
 * counts, not new spend — billing truth lives in chat-service's cost rows.
 */
function toGenerationResponse(generation: {
  id: string;
  subject: string | null;
  sequence: unknown;
  tokensInput: number | null;
  tokensOutput: number | null;
}) {
  return {
    id: generation.id,
    // Rows stored before the dash strip (dashes.ts) are re-served to uncontacted
    // leads, so the same rule applies here; rows stored since are unchanged by it.
    subject: stripDashes(generation.subject ?? ""),
    // Stored rows predate the generation-time check (glm/deepseek dropped step 1's
    // delay), and the lead-retry path re-serves them — so the same rule applies here.
    sequence: withSequenceDelays(
      (generation.sequence ?? []) as Array<{ daysSinceLastStep?: unknown; bodyText?: unknown }>,
      generation.id
    ).map(withoutDashes),
    tokensInput: generation.tokensInput ?? 0,
    tokensOutput: generation.tokensOutput ?? 0,
  };
}

/** A stored step with a dash in its body gets the stripped text and HTML regenerated from it. */
function withoutDashes<T extends { bodyText?: unknown }>(step: T): T {
  if (typeof step.bodyText !== "string" || !hasDashes(step.bodyText)) return step;
  const bodyText = stripDashes(step.bodyText);
  return { ...step, bodyText, bodyHtml: textToHtml(bodyText) };
}

/**
 * True for the Postgres unique-violation raised by `idx_emailgen_lead`
 * (UNIQUE on campaign_id, lead_id). Deliberately narrow: any other error —
 * including a unique violation on a different index — is rethrown.
 */
function isLeadDuplicateError(err: unknown): boolean {
  return isUniqueViolation(err, "idx_emailgen_lead");
}

type GenerateBody = z.infer<typeof GenerateRequestSchema>;

/** Who and what one generation request is for (body first, then the identity headers workflow-service sends). */
function scopeOf(req: AuthenticatedRequest, data: GenerateBody) {
  // Header values (from workflow-service) serve as fallback when body values are missing
  const brandIds = data.brandIds?.length ? data.brandIds : (req.brandIds ?? []);
  // Raw CSV string for identity forwarding to downstream services
  const brandId = brandIds.length > 0 ? brandIds.join(",") : req.brandId;
  const campaignId = data.campaignId || req.campaignId;
  const workflowSlug = data.workflowSlug || req.workflowSlug;
  const featureSlug = data.featureSlug || req.featureSlug;
  const audienceId = data.audienceId || req.audienceId;
  // The campaign's offer — brand-service refuses a brand-scoped extract-fields
  // request for a brand selling several offers until one is named. Body only:
  // workflow-service threads it into the request BODY of this callee, never a header.
  const offerId = data.offerId;
  const serviceIdentity = { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, campaignId, brandId, workflowSlug, featureSlug, audienceId, offerId };
  // The campaign a lead's generation is stored under. `campaignId` is nullable on
  // the wire but the column is NOT NULL, so the insert below normalizes it to "";
  // the lead lookup must use the same value or it would miss its own rows.
  const leadCampaignId = campaignId ?? "";
  return { brandIds, brandId, campaignId, workflowSlug, featureSlug, audienceId, offerId, serviceIdentity, leadCampaignId };
}
type GenerateScope = ReturnType<typeof scopeOf>;

/**
 * The stored generation this request is already answered by, or null: the idempotency key, then the lead's one email
 * per campaign. Retry recovery: a lead that already has a generation for this campaign gets that email back instead
 * of a second, billed completion. `idx_emailgen_lead` is UNIQUE on (campaign_id, lead_id) — one email per person per
 * campaign — so the retry could only ever have produced a duplicate-key throw, AFTER the completion was paid for.
 * Returning the stored email is what the retry actually needs: these leads were never contacted, so nothing about the
 * email is stale to its recipient. See issue #186.
 */
async function answeredGeneration(req: AuthenticatedRequest, data: GenerateBody, scope: GenerateScope) {
  if (data.idempotencyKey) {
    const existing = await db.query.emailGenerations.findFirst({
      where: and(
        eq(emailGenerations.orgId, req.orgId!),
        eq(emailGenerations.idempotencyKey, data.idempotencyKey)
      ),
    });
    if (existing) {
      traceEvent(req.runId!, { service: "content-generation-service", event: "idempotency-hit", detail: `Returning cached generation id=${existing.id} for key=${data.idempotencyKey}` }, req.headers).catch(() => {});
      return existing;
    }
  }
  if (data.leadId) {
    const existingForLead = await db.query.emailGenerations.findFirst({
      where: and(
        eq(emailGenerations.orgId, req.orgId!),
        eq(emailGenerations.campaignId, scope.leadCampaignId),
        eq(emailGenerations.leadId, data.leadId)
      ),
    });
    if (existingForLead) {
      traceEvent(req.runId!, { service: "content-generation-service", event: "lead-generation-hit", detail: `Returning existing generation id=${existingForLead.id} for leadId=${data.leadId}, campaignId=${scope.leadCampaignId || "none"} — no completion billed` }, req.headers).catch(() => {});
      return existingForLead;
    }
  }
  return null;
}

/**
 * Everything the writer is handed beyond the request: the stored template, the campaign context, unfilled brand
 * fields (written INTO `data.variables`), the recipient's language, the offer's give lists and the campaign's
 * instruction. `null` = no stored prompt for this type.
 */
async function writingMaterials(req: AuthenticatedRequest, data: GenerateBody, scope: GenerateScope) {
  const { type, variables, leadId } = data;
  const { brandIds, campaignId, offerId, serviceIdentity } = scope;

  // Look up the stored prompt by type (globally unique)
  const storedPrompt = await db.query.prompts.findFirst({
    where: eq(prompts.type, type),
  });
  if (!storedPrompt) return null;

  traceEvent(req.runId!, { service: "content-generation-service", event: "prompt-resolved", detail: `Loaded stored prompt type=${type}, promptId=${storedPrompt.id ?? "unknown"}` }, req.headers).catch(() => {});

  // Convention 2: fetch campaign featureInputs for LLM context enrichment
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
        const brandValues = await extractBrandFields(unfilledBrandFieldRequests(unfilled), serviceIdentity);
        for (const [key, value] of brandValues) {
          variables[key] = value;
        }
      }
    } catch (err) {
      console.warn("[content-gen] Failed to resolve brand fields — proceeding with available variables.", err instanceof Error ? err.message : err);
    }
  }

  // Write the email in the recipient's language rather than always in English.
  // `businessLanguages` comes from lead-service (ISO 639-1, produced by
  // human-service), ordered most-plausible-first; the
  // selection rule is English-preferring, so a directive is emitted only for
  // someone who reads no English at all (see `resolveLeadLanguage`). No lead,
  // no answer, or an unusable list all mean "no directive" — identical to the
  // behaviour that shipped before this existed.
  let language: string | null = null;
  if (leadId) {
    const languages = await getLeadBusinessLanguages(leadId, serviceIdentity);
    language = resolveLeadLanguage(languages);
    if (language) {
      traceEvent(req.runId!, { service: "content-generation-service", event: "lead-language-resolved", detail: `Writing in ${language} for leadId=${leadId}` }, req.headers).catch(() => {});
    }
  }

  // The offer's confirmed give lists: what the sender gives for free to a prospect
  // who replies (the email's ask) and what it never gives. Read only when the run
  // names its offer — workflow-service injects `offerId` into every /generate body,
  // and every live campaign has one. A brand-service failure degrades loudly to no
  // lists, i.e. the email is written exactly as it was before this existed.
  let giveLists: OfferGiveLists | null = null;
  if (offerId && brandIds.length === 1) {
    try {
      giveLists = await fetchOfferGiveLists(serviceIdentity);
    } catch (err) {
      console.error(`[content-gen] Could not read the offer's give lists (offerId=${offerId}) — generating without them.`, err instanceof Error ? err.message : err);
      traceEvent(req.runId!, { service: "content-generation-service", event: "offer-give-lists-unavailable", detail: `offerId=${offerId}: ${err instanceof Error ? err.message : String(err)}`, level: "warn" }, req.headers).catch(() => {});
    }
    if (hasGiveLists(giveLists)) {
      traceEvent(req.runId!, { service: "content-generation-service", event: "offer-give-lists-resolved", detail: `offerId=${offerId}, giveForFree=${giveLists.giveForFree.length}, neverGive=${giveLists.neverGive.length}` }, req.headers).catch(() => {});
    }
  }

  // The campaign's own instruction, when its run carries one: the email is written from it
  // (see campaign-instruction.ts). Body only, threaded by workflow-service from /start-run.
  const instruction = normalizeInstruction(data.instruction);
  if (instruction) {
    traceEvent(req.runId!, { service: "content-generation-service", event: "campaign-instruction-applied", detail: `Writing from the campaign's instruction (${instruction.length} chars)` }, req.headers).catch(() => {});
  }

  return { storedPrompt, campaignContext, language, giveLists, instruction };
}

const noPrompt = (type: string) => ({
  error: `No prompt found for type=${type}. Register one via POST /prompts or POST /platform-prompts first.`,
});

/** The row's dedicated lead/client columns, read from the variables. */
function variableColumns(variables: Record<string, unknown>) {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    leadFirstName: str(variables.leadFirstName),
    leadLastName: str(variables.leadLastName),
    leadTitle: str(variables.leadTitle),
    leadCompany: str(variables.leadCompanyName),
    leadIndustry: str(variables.leadCompanyIndustry),
    leadOrganizationDomain: str(variables.organizationDomain),
    clientCompanyName: str(variables.clientCompanyName),
  };
}

/** Maps the errors of the generate routes to their answer (shared by /generate and /generate/materials). */
function generateErrorResponse(req: AuthenticatedRequest, res: Response, error: unknown) {
  if (error instanceof UnknownModelError) {
    return res.status(400).json({ error: error.message, code: error.code, accepted: error.accepted });
  }
  if (error instanceof WrittenByScriptError) {
    console.error("Generate error:", error.message);
    return res.status(400).json({ error: error.message, code: "WRITTEN_BY_SCRIPT_UNREADABLE" });
  }
  if (error instanceof ChatModelCatalogueError) {
    console.error("Generate error:", error.message);
    return res.status(502).json({ error: error.message, code: error.code });
  }
  if (error instanceof InsufficientCreditsError) {
    return res.status(402).json({
      error: "Insufficient credits",
      balance_cents: error.balance_cents,
      required_cents: error.required_cents,
    });
  }
  if (error instanceof IncompleteSequenceError) {
    console.error("Generate error:", error.message);
    if (req.runId) {
      traceEvent(req.runId, { service: "content-generation-service", event: "incomplete-sequence", detail: error.message, level: "error" }, req.headers).catch(() => {});
    }
    return res.status(502).json({ error: error.message, steps: error.steps });
  }
  if (error instanceof ClientCommsVoiceError) {
    // No default voice: the email is not written without our client-comms skill.
    console.error("Generate error:", error.message);
    if (req.runId) {
      traceEvent(req.runId, { service: "content-generation-service", event: "client-comms-unavailable", detail: error.message, level: "error" }, req.headers).catch(() => {});
    }
    return res.status(502).json({ error: error.message, code: "CLIENT_COMMS_UNAVAILABLE" });
  }
  console.error("Generate error:", error);
  if (req.runId) {
    traceEvent(req.runId, { service: "content-generation-service", event: "generate-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
}

/**
 * POST /generate/materials — the script writer's step materials (FACTORY-P3 fleet writer, `src/lib/script-writer.ts`).
 * Same body as /generate; does everything /generate does BEFORE the completion and answers either the stored
 * generation that already answers this request (`existing`: the script step is skipped and /generate returns it) or
 * the script step's `subject`, `units` and `tactics` (the asked LLM, its provider read from chat-service's catalogue).
 * Spends nothing on the writer; the brand-field extraction is billed as on /generate.
 */
router.post("/generate/materials", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }
    const data = parsed.data;
    const model = data.model ?? DEFAULT_MODEL;
    // The model name is checked against chat-service's catalogue before anything is read or billed (400 UNKNOWN_MODEL).
    const { provider } = await resolveChatModel(model);
    const scope = scopeOf(req, data);
    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-materials-start", detail: `type=${data.type}, brandIds=${scope.brandIds.join(",")}, campaignId=${scope.campaignId ?? "none"}` }, req.headers).catch(() => {});

    const existing = await answeredGeneration(req, data, scope);
    if (existing) return res.json({ existing: toGenerationResponse(existing), subject: null, units: null, tactics: null });
    if (!data.leadId) {
      return res.status(400).json({ error: "leadId is required: the script writer declares its message on the person's lead" });
    }

    const m = await writingMaterials(req, data, scope);
    if (!m) return res.status(404).json(noPrompt(data.type));

    res.json({
      existing: null,
      subject: { service: LEAD_SUBJECT_SERVICE, id: data.leadId },
      units: writerUnits({
        promptTemplate: m.storedPrompt.prompt,
        variables: data.variables,
        campaignContext: m.campaignContext,
        language: m.language,
        giveLists: m.giveLists,
        instruction: m.instruction,
      }),
      tactics: { llm: { provider, model } },
    });
  } catch (error) {
    generateErrorResponse(req, res, error);
  }
});

/**
 * Stores the email the script writer wrote (`/generate` with `written`): the same row, the same
 * `message_written` declaration (on the SCRIPT's run, by this service's never-lost machinery), the same answer.
 */
async function recordWrittenByScript(req: AuthenticatedRequest, res: Response, data: GenerateBody, scope: GenerateScope) {
  const storedPrompt = await db.query.prompts.findFirst({ where: eq(prompts.type, data.type) });
  if (!storedPrompt) return res.status(404).json(noPrompt(data.type));
  const w = readWrittenByScript(data.written, data.units);
  const { serviceIdentity, leadCampaignId } = scope;
  const leadId = data.leadId;

  // The step this message's pipe starts from is what it consumes (PIPE-FROM-STEP-1024).
  const pipeFrom = leadId ? await messageFromStep(scope.campaignId, serviceIdentity) : null;
  const outcomes = messageWrittenDeclaration({ leadId, variables: w.variables, pipeFromStep: pipeFrom?.known ? pipeFrom.fromStep : null });

  const insertValues = {
    orgId: req.orgId!,
    runId: req.runId!,
    apolloEnrichmentId: data.apolloEnrichmentId ?? null,
    promptType: data.type,
    brandIds: scope.brandIds,
    campaignId: leadCampaignId,
    variablesRaw: w.variables,
    ...variableColumns(w.variables),
    subject: w.subject,
    sequence: w.sequence,
    model: w.model,
    tokensInput: w.tokensInput,
    tokensOutput: w.tokensOutput,
    promptRaw: w.promptRaw,
    responseRaw: w.responseRaw,
    chatRequest: w.chatRequest,
    chatRequestInputs: w.chatRequestInputs,
    workflowSlug: scope.workflowSlug ?? null,
    featureSlug: scope.featureSlug ?? null,
    audienceId: scope.audienceId ?? null,
    leadId: leadId ?? null,
    idempotencyKey: data.idempotencyKey ?? null,
    // The script's run wrote it: the completion is its child, the declaration lands on it.
    generationRunId: w.runId,
    outcomes,
  };

  let generation;
  try {
    [generation] = await db.insert(emailGenerations).values(insertValues as typeof emailGenerations.$inferInsert).returning();
  } catch (err) {
    // A concurrent request for the same lead won the insert: its email is the answer (one email per person per
    // campaign); the script's run declared nothing, so nothing is counted twice.
    if (!leadId || !isLeadDuplicateError(err)) throw err;
    const winner = await db.query.emailGenerations.findFirst({
      where: and(eq(emailGenerations.orgId, req.orgId!), eq(emailGenerations.campaignId, leadCampaignId), eq(emailGenerations.leadId, leadId)),
    });
    if (!winner) throw err;
    traceEvent(req.runId!, { service: "content-generation-service", event: "lead-generation-race", detail: `Concurrent generation won for leadId=${leadId}, campaignId=${leadCampaignId || "none"} — returning id=${winner.id}`, level: "warn" }, req.headers).catch(() => {});
    return res.json(toGenerationResponse(winner));
  }

  if (outcomes) void declareStoredOutcomes("email_generations", generation.id);
  traceEvent(req.runId!, { service: "content-generation-service", event: "generate-recorded", detail: `generationId=${generation.id}, written by script run ${w.runId}, model=${w.model}` }, req.headers).catch(() => {});
  return res.json({ id: generation.id, subject: w.subject, sequence: w.sequence, tokensInput: w.tokensInput, tokensOutput: w.tokensOutput });
}

/**
 * POST /generate — Generate content using a stored prompt template + variables.
 * With `written` (+ `units`): store the email the script writer wrote instead (see /generate/materials).
 */
router.post("/generate", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = GenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }
    const data = parsed.data;
    const { type, variables, model, leadId, apolloEnrichmentId } = data;

    // The model name is checked against chat-service's catalogue before anything is read or
    // billed (400 UNKNOWN_MODEL); omitted → the default, resolved at the completion.
    if (model) await resolveChatModel(model);
    const scope = scopeOf(req, data);
    const { brandIds, brandId, campaignId, workflowSlug, serviceIdentity, leadCampaignId } = scope;

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-start", detail: `type=${type}, brandIds=${brandIds.join(",")}, campaignId=${campaignId ?? "none"}, idempotencyKey=${data.idempotencyKey ?? "none"}` }, req.headers).catch(() => {});

    const existing = await answeredGeneration(req, data, scope);
    if (existing) return res.json(toGenerationResponse(existing));

    if (data.written !== undefined) return await recordWrittenByScript(req, res, data, scope);

    const m = await writingMaterials(req, data, scope);
    if (!m) return res.status(404).json(noPrompt(type));
    const { storedPrompt, campaignContext, language, giveLists, instruction } = m;

    // This service's run for the writing call, opened BEFORE the completion so chat-service's
    // `/complete` run (and its cost) is its child: the run then declares the message it wrote
    // (COST-ACCOUNTING-1023-P1, src/lib/run-outcomes.ts). Run tracking never blocks the email:
    // if runs-service refuses, the completion runs under the caller's run, as before, and
    // nothing is declared (logged loud).
    let generationRunId: string | null = null;
    try {
      const genRun = await createRun({
        brandId,
        campaignId,
        serviceName: "content-generation-service",
        taskName: "single-generation",
        workflowSlug,
      }, serviceIdentity);
      generationRunId = genRun.id;
    } catch (err) {
      console.error("[content-gen] RUN TRACKING FAILED.", {
        runId: req.runId,
        apolloEnrichmentId,
        error: err instanceof Error ? err.message : err,
      });
    }
    const finishGenerationRun = async (status: "completed" | "failed") => {
      if (!generationRunId) return;
      try {
        await updateRun(generationRunId, status, { ...serviceIdentity, runId: generationRunId });
      } catch (err) {
        console.error("[content-gen] RUN TRACKING FAILED.", {
          runId: req.runId,
          generationRunId,
          error: err instanceof Error ? err.message : err,
        });
      }
    };
    // The step this message's pipe starts from is what it consumes (PIPE-FROM-STEP-1024).
    const pipeFrom = generationRunId && leadId ? await messageFromStep(campaignId, serviceIdentity) : null;
    const outcomes = generationRunId
      ? messageWrittenDeclaration({ leadId, variables, pipeFromStep: pipeFrom?.known ? pipeFrom.fromStep : null })
      : null;
    if (generationRunId && !outcomes) {
      console.warn(`[content-gen] message written without a leadId: no outcome declared (run=${generationRunId})`);
    }

    // Generate using the stored prompt + variable substitution + campaign context
    // Chat-service handles key resolution, billing, and cost tracking internally
    traceEvent(req.runId!, { service: "content-generation-service", event: "llm-call-start", detail: `Calling chat-service with prompt type=${type}, variableCount=${Object.keys(variables).length}, hasCampaignContext=${!!campaignContext}, language=${language ?? "english"}` }, req.headers).catch(() => {});
    let result: Awaited<ReturnType<typeof generateFromTemplate>>;
    try {
      result = await generateFromTemplate(
      {
        promptTemplate: storedPrompt.prompt,
        variables,
        campaignContext,
        model,
        language,
        giveLists,
        instruction,
        onRegenerate: ({ attempt, reason }) => {
          traceEvent(req.runId!, { service: "content-generation-service", event: "llm-regenerate", detail: `Unusable sequence, regenerating (attempt ${attempt}): ${reason}`, level: "warn" }, req.headers).catch(() => {});
        },
      },
      { ...serviceIdentity, runId: generationRunId ?? req.runId! }
      );
    } catch (err) {
      await finishGenerationRun("failed");
      throw err;
    }

    traceEvent(req.runId!, { service: "content-generation-service", event: "llm-call-done", detail: `model=${result.model}, tokensIn=${result.tokensInput}, tokensOut=${result.tokensOutput}, sequenceLen=${result.sequence?.length ?? 0}`, data: { model: result.model, tokensInput: result.tokensInput, tokensOutput: result.tokensOutput } }, req.headers).catch(() => {});

    // Store in database
    const insertValues = {
      orgId: req.orgId!,
      runId: req.runId!,
      apolloEnrichmentId: apolloEnrichmentId ?? null,
      promptType: type,
      brandIds: brandIds,
      campaignId: leadCampaignId,
      variablesRaw: variables,
      // Populate dedicated lead/client columns from variables
      ...variableColumns(variables),
      subject: result.subject,
      sequence: result.sequence,
      model: result.model,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      promptRaw: result.promptRaw,
      responseRaw: result.responseRaw,
      // The exact chat-service request + its inputs, in the SAME insert (FACTORY-P3-RECORD-SYSTEM-PROMPT).
      chatRequest: result.chatRequest,
      chatRequestInputs: result.chatRequestInputs,
      workflowSlug: workflowSlug ?? null,
      featureSlug: scope.featureSlug ?? null,
      audienceId: scope.audienceId ?? null,
      leadId: leadId ?? null,
      idempotencyKey: data.idempotencyKey ?? null,
      generationRunId,
      outcomes,
    };

    let generation;
    try {
      [generation] = await db.insert(emailGenerations).values(insertValues).returning();
    } catch (err) {
      // A concurrent retry of the same lead won the insert between our lookup above and
      // this write. The unique index is the invariant we want — one email per person per
      // campaign — so the winner's email is the correct answer, and the caller still gets
      // an email to push instead of a failed run. This completion is wasted; the lookup
      // above is what keeps that rare rather than routine. Anything else rethrows.
      if (!leadId || !isLeadDuplicateError(err)) {
        await finishGenerationRun("failed");
        throw err;
      }
      // The winner's run declared this person's message; ours wrote a discarded one.
      await finishGenerationRun("completed");

      const winner = await db.query.emailGenerations.findFirst({
        where: and(
          eq(emailGenerations.orgId, req.orgId!),
          eq(emailGenerations.campaignId, leadCampaignId),
          eq(emailGenerations.leadId, leadId)
        ),
      });
      if (!winner) throw err;

      traceEvent(req.runId!, { service: "content-generation-service", event: "lead-generation-race", detail: `Concurrent generation won for leadId=${leadId}, campaignId=${leadCampaignId || "none"} — returning id=${winner.id}`, level: "warn" }, req.headers).catch(() => {});
      return res.json(toGenerationResponse(winner));
    }

    await finishGenerationRun("completed");
    // The declaration is stored on the row; one attempt now, the sweep retries until it lands.
    if (outcomes) void declareStoredOutcomes("email_generations", generation.id);

    traceEvent(req.runId!, { service: "content-generation-service", event: "generate-done", detail: `generationId=${generation.id}, subject="${result.subject?.slice(0, 60) ?? ""}"` }, req.headers).catch(() => {});

    res.json({
      id: generation.id,
      subject: result.subject,
      sequence: result.sequence,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    });
  } catch (error) {
    generateErrorResponse(req, res, error);
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
    if (model) await resolveChatModel(model);

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
    if (error instanceof UnknownModelError) {
      return res.status(400).json({ error: error.message, code: error.code, accepted: error.accepted });
    }
    if (error instanceof ChatModelCatalogueError) {
      console.error("Generate expert-quote pitch error:", error.message);
      return res.status(502).json({ error: error.message, code: error.code });
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
      columns: RECORDED_REQUEST_COLUMNS_OFF,
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

    // Serve the copy that was actually written: the top-level body columns have been empty
    // since sequences shipped, so each row resolves its body (see src/lib/generation-body.ts).
    res.json({ generations: generations.map(withResolvedBody) });
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
      columns: RECORDED_REQUEST_COLUMNS_OFF,
      where: (gens, { eq, and }) =>
        and(
          eq(gens.apolloEnrichmentId, apolloEnrichmentId),
          eq(gens.orgId, req.orgId!)
        ),
    });

    if (!generation) {
      return res.status(404).json({ error: "Generation not found" });
    }

    res.json({ generation: withResolvedBody(generation) });
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
 *
 * Optional `?campaignId=<id>` scopes the read to ONE campaign. A person contacted by
 * several campaigns of the SAME brand has one generation per campaign (the unique
 * `idx_emailgen_lead` on `(campaign_id, lead_id)` guarantees exactly one), so the brand
 * scope alone is still ambiguous for them — 3,193 leads in production hold generations
 * under two or more campaigns. With `campaignId` the read is exact: it is the one email
 * that campaign sent this person, or 404 if that campaign never wrote to them. The
 * campaign a returned generation belongs to is already on the row (`campaignId`), which
 * this route returns whole — so an unscoped or brand-scoped caller can read which
 * campaign it got without asking a second question. No campaign is ever inferred: absent
 * the parameter, nothing about campaign scoping changes.
 */
router.get("/generations/by-lead/:leadId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { leadId } = req.params;
    const { brandId, campaignId } = req.query as { brandId?: string; campaignId?: string };

    const generation = await findGenerationForLead({
      orgId: req.orgId!,
      leadId,
      brandId,
      campaignId,
    });

    if (!generation) {
      return res.status(404).json({ error: "Generation not found" });
    }

    res.json({ generation: withResolvedBody(generation) });
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
