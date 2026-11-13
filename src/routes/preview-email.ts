import { Router } from "express";
import { ChatModelCatalogueError, UnknownModelError, resolveChatModel } from "../lib/chat-model-catalogue.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailPreviews, prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { clientIdentityTerms, maskClientIdentity } from "../lib/client-identity-mask.js";
import { dynastyIdentityOf } from "../lib/dynasty-membership.js";
import { extractBrandFields, fetchBrandIntel, BrandIntelError } from "../lib/brand-client.js";
import { unfilledBrandFieldRequests } from "../lib/unfilled-brand-fields.js";
import { fetchOfferGiveLists, OfferGiveListsError } from "../lib/offer-give-lists-client.js";
import { extractTemplateVariableNames } from "../lib/template-vars.js";
import { textToHtml } from "../lib/text-to-html.js";
import { traceEvent } from "../lib/trace-event.js";
import { resolvePreviewWriter } from "../lib/preview-writer-client.js";
import { PREVIEW_ENGINE_OUTCOME, PreviewWriterError, previewVariables, scriptSlugOf } from "../lib/preview-writer.js";
import { runScript, ScriptRunError } from "../lib/script-run-client.js";
import { readWrittenByScript, writerUnits, WrittenByScriptError } from "../lib/script-writer.js";
import { awaitPreviewWarmup, startPreviewWarmup } from "../lib/preview-warmup.js";
import {
  BRAND_INTEL_FIELDS,
  buildPreviewContext,
  previewQualificationVariable,
  previewRecipientKey,
  type PreviewRecipient,
} from "../lib/preview-email.js";
import {
  PREVIEW_ANNOTATION_VERSION,
  buildHighlightSources,
  resolveHighlights,
  type HighlightSource,
  type PreviewHighlight,
} from "../lib/preview-highlights.js";
import { annotatePreviewEmail } from "../lib/preview-annotate-client.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { PreviewEmailRequestSchema, PreviewEmailPrepareRequestSchema } from "../schemas.js";

const router = Router();

type PreviewRow = typeof emailPreviews.$inferSelect;

function toPreviewResponse(row: PreviewRow, cached: boolean) {
  return {
    id: row.id,
    brandId: row.brandId,
    brandName: row.brandName,
    recipient: row.recipient as PreviewRecipient,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    model: row.model,
    // What wrote it: the email Engine's script, the template (dynasty + version) and the LLM asked. A row
    // written before PREVIEW-EMAIL-503-1111 names its workflow instead and no script.
    promptType: row.promptType,
    modelAlias: row.modelAlias ?? null,
    scriptSlug: row.scriptSlug ?? null,
    templateDynastySlug: row.templateDynastySlug ?? null,
    workflowSlug: row.workflowSlug ?? null,
    highlights: (row.highlights as PreviewHighlight[] | null) ?? null,
    cached,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

/**
 * The "why" per sentence, from a SECOND completion on the finished first email. The
 * email never depends on it: any failure (402 included) is logged loud and answered
 * `null`, so the preview is served without highlights and a later repeat retries.
 */
async function annotateFirstEmail(
  bodyText: string,
  sources: HighlightSource[],
  identity: Parameters<typeof annotatePreviewEmail>[1],
  req: AuthenticatedRequest
): Promise<PreviewHighlight[] | null> {
  try {
    const annotation = await annotatePreviewEmail({ bodyText, sources }, identity);
    const highlights = resolveHighlights(annotation.highlights, bodyText, sources);
    if (highlights.length < annotation.highlights.length) {
      console.warn(`[content-generation-service] /preview-email dropped ${annotation.highlights.length - highlights.length}/${annotation.highlights.length} highlights that were not verbatim in the body or named an input that was not sent (brandId=${identity.brandId})`);
    }
    traceEvent(identity.runId, { service: "content-generation-service", event: "preview-email-annotated", detail: `model=${annotation.model}, highlights=${highlights.length}/${annotation.highlights.length}, tokensIn=${annotation.tokensInput}, tokensOut=${annotation.tokensOutput}` }, req.headers).catch(() => {});
    return highlights;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[content-generation-service] /preview-email annotate FAILED, serving the email without highlights (brandId=${identity.brandId}): ${message}`);
    traceEvent(identity.runId, { service: "content-generation-service", event: "preview-email-annotate-error", detail: message, level: "error" }, req.headers).catch(() => {});
    return null;
  }
}

function isPreviewDuplicateError(err: unknown): boolean {
  return isUniqueViolation(err, "idx_email_previews_recipient");
}

/**
 * POST /preview-email — ONE cold email for a brand of the calling org and a sample recipient, written before any
 * campaign or lead exists (the onboarding's and the Copilot's "show me the first email"). It is written the way a
 * campaign writes it (PREVIEW-EMAIL-503-1111): by the email Engine's script (workflow-service, the script the strategy
 * keeps, features-service), with the template + LLM the cold email script the Rating picks states for its writing call, from the materials this
 * service builds for every script writer. No fallback script, template or model: none = a named refusal.
 *
 * Billing: the only paid call is the script's completion, which chat-service provisions, authorizes and declares
 * against the calling org (x-org-id), exactly like a campaign email. An org that cannot afford it is answered 402.
 *
 * Nothing sendable: no campaign, no lead, and no email_generations row (the script run is started `recordedBy`
 * content-generation and declares nothing). The result is stored in email_previews, which only this route reads, so a
 * repeat call for the same brand + recipient returns it without a second completion.
 */
router.post("/preview-email", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const runId = req.runId!;
  try {
    const parsed = PreviewEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
    }
    if (req.body && typeof req.body === "object" && "model" in req.body) {
      return res.status(400).json({ error: "model: not accepted; the preview writes with the LLM the cold email script the Rating picks states" });
    }
    const { brandId, recipient, audience, offerId, qualification, strategyId } = parsed.data;
    const orgId = req.orgId!;
    const identity = { orgId, userId: req.userId!, runId, brandId, offerId };

    // The offer's confirmed give lists shape the email (its ask, and what it must never
    // offer), so they are read first and are part of the stored preview's identity.
    // A plain read, nothing billed; a refusal fails the preview like its brand intel does.
    const giveLists = await fetchOfferGiveLists(identity);

    // The email Engine's script the strategy keeps, and the template + LLM the cold email script the Rating picks
    // states for its writing call (both picks cached a few minutes). Part of the stored preview's identity, so a new script version, template
    // or LLM writes a new preview.
    const plan = await resolvePreviewWriter(identity, strategyId);
    const scriptSlug = scriptSlugOf(plan.script);

    const recipientKey = previewRecipientKey({ recipient, audience, offerId, promptType: plan.promptType, model: plan.model, writerSlug: scriptSlug, annotationVersion: PREVIEW_ANNOTATION_VERSION, giveLists, qualification });
    const findStored = () =>
      db.query.emailPreviews.findFirst({
        where: and(
          eq(emailPreviews.orgId, orgId),
          eq(emailPreviews.brandId, brandId),
          eq(emailPreviews.recipientKey, recipientKey)
        ),
      });

    // A repeat of the same brand + recipient is answered from storage BEFORE any
    // downstream call: nothing is read, nothing is billed.
    const existing = await findStored();
    if (existing) {
      traceEvent(runId, { service: "content-generation-service", event: "preview-email-hit", detail: `Returning stored preview id=${existing.id} for brandId=${brandId} — no completion billed` }, req.headers).catch(() => {});
      return res.json(toPreviewResponse(existing, true));
    }

    // The brand facts the Engine's cold-email script asks brand-service for; also the check that brandId is a brand
    // of this org, and the brand's name. A warm-up in flight for this brand (POST /preview-email/prepare) is doing
    // this very read: wait for it, then read its cache instead of starting a second site read.
    await awaitPreviewWarmup(orgId, brandId);
    const intel = await fetchBrandIntel(BRAND_INTEL_FIELDS, identity);
    const brandName = intel.brands[0]?.name;
    if (!brandName) {
      throw new Error(`brand-service returned no brand for brandId=${brandId}`);
    }

    const storedPrompt = await db.query.prompts.findFirst({ where: eq(prompts.type, plan.promptType) });
    if (!storedPrompt) {
      throw new Error(`Preview prompt type=${plan.promptType} (head of template dynasty ${plan.templateDynastySlug}) is not registered`);
    }

    const templateTokens = extractTemplateVariableNames(storedPrompt.prompt);
    const variables = previewVariables(
      { recipient, clientName: brandName, brandExtractedFields: intel.fields ?? {}, currentDate: new Date().toISOString().split("T")[0] },
      templateTokens
    );
    // The recipient company's check results ride in `leadQualification`, exactly as a campaign run hands the
    // writer its served lead's qualification.
    const leadQualification = previewQualificationVariable(qualification);
    if (leadQualification) variables.leadQualification = leadQualification;
    // A template input nothing filled is asked of brand-service, exactly as /generate does (Convention 1);
    // anything still missing is "" so no {{token}} leaks.
    const unmapped = templateTokens.filter((t) => !(t in variables));
    if (unmapped.length > 0) {
      for (const [key, value] of await extractBrandFields(unfilledBrandFieldRequests(unmapped), identity)) variables[key] = value;
    }
    for (const token of templateTokens) {
      if (!(token in variables)) variables[token] = "";
    }

    // Everything the email could rest on, from the inputs actually sent. A second
    // completion, after the email is written, reports which of these each sentence uses.
    const sources = buildHighlightSources({ recipient, audience, brandName, brandFields: intel.fields ?? {}, giveForFree: giveLists?.giveForFree, qualification: leadQualification });

    // A blind dynasty's writer never sees who the client is (BLIND-NAME-LEAK-1105), exactly as on /generate.
    const blind = (await dynastyIdentityOf(plan.promptType)) === "blind";
    const terms = blind ? clientIdentityTerms(intel.brands) : null;
    const writerVariables = terms ? maskClientIdentity(variables, terms) : variables;
    const writerGiveLists = terms && giveLists ? maskClientIdentity(giveLists, terms) : giveLists;
    const campaignContext = buildPreviewContext(audience);

    // The materials every script writer is handed (/generate/materials), and the picked LLM with its provider.
    const { provider } = await resolveChatModel(plan.model);
    const units = writerUnits({
      promptTemplate: storedPrompt.prompt,
      variables: writerVariables,
      campaignContext: terms && campaignContext ? maskClientIdentity(campaignContext, terms) : campaignContext,
      language: null,
      giveLists: writerGiveLists,
      brief: null,
    });

    traceEvent(runId, { service: "content-generation-service", event: "preview-email-start", detail: `brandId=${brandId}, script=${scriptSlug}, template=${plan.templateDynastySlug} (${plan.promptType}), model=${plan.model}, checks=${leadQualification ? (leadQualification.checks as unknown[]).length : 0}` }, req.headers).catch(() => {});
    // The email Engine's script writes it, under the caller's run and org. `recordedBy` = this service records the
    // Unit: the script's run declares nothing (a preview is no message to anyone).
    const answer = await runScript(
      {
        outcome: PREVIEW_ENGINE_OUTCOME,
        dynasty: plan.script.dynasty,
        version: plan.script.version,
        subject: { service: "content-generation-service", id: `preview:${recipientKey}` },
        units,
        tactics: { llm: { provider, model: plan.model } },
        recordedBy: "content-generation",
        trace: true,
      },
      identity
    );
    const written = readWrittenByScript(answer, units);

    const first = written.sequence[0] as { bodyText?: string; bodyHtml?: string } | undefined;
    if (!first || !first.bodyText) {
      throw new Error(`The script ${scriptSlug} wrote no email body for the preview (brandId=${brandId})`);
    }
    const bodyHtml = first.bodyHtml ?? textToHtml(first.bodyText);

    const highlights = await annotateFirstEmail(first.bodyText, sources, identity, req);

    let row: PreviewRow;
    try {
      [row] = await db
        .insert(emailPreviews)
        .values({
          orgId,
          brandId,
          brandName,
          runId,
          recipientKey,
          recipient,
          promptType: plan.promptType,
          modelAlias: plan.model,
          scriptSlug,
          templateDynastySlug: plan.templateDynastySlug,
          subject: written.subject,
          bodyText: first.bodyText,
          bodyHtml,
          sequence: written.sequence,
          model: written.model ?? plan.model,
          tokensInput: written.tokensInput,
          tokensOutput: written.tokensOutput,
          promptRaw: written.promptRaw,
          responseRaw: written.responseRaw,
          highlights,
        })
        .returning();
    } catch (err) {
      // A concurrent identical call won the insert; its email is the answer.
      if (!isPreviewDuplicateError(err)) throw err;
      const winner = await findStored();
      if (!winner) throw err;
      return res.json(toPreviewResponse(winner, true));
    }

    traceEvent(runId, { service: "content-generation-service", event: "preview-email-done", detail: `previewId=${row.id}, script run ${written.runId}, model=${written.model}, highlights=${highlights === null ? "failed" : highlights.length}, tokensIn=${written.tokensInput}, tokensOut=${written.tokensOutput}` }, req.headers).catch(() => {});
    res.json(toPreviewResponse(row, false));
  } catch (error) {
    if (error instanceof PreviewWriterError || error instanceof ScriptRunError) {
      // No script, template or LLM to write with, or the script failed: there is no fallback, so the preview is
      // refused rather than written by anything else.
      console.error("[content-generation-service] /preview-email writer error:", error.message);
      traceEvent(runId, { service: "content-generation-service", event: "preview-email-error", detail: error.message, level: "error" }, req.headers).catch(() => {});
      if (error.status === 402) return res.status(402).json({ error: "Insufficient credits", detail: error.message });
      const code = error instanceof PreviewWriterError ? error.code : "SCRIPT_RUN_FAILED";
      return res.status(error.status).json({ error: error.message, ...(code ? { code } : {}) });
    }
    if (error instanceof WrittenByScriptError) {
      console.error("[content-generation-service] /preview-email script answer unreadable:", error.message);
      return res.status(502).json({ error: error.message, code: "SCRIPT_WROTE_NOTHING" });
    }
    if (error instanceof UnknownModelError || error instanceof ChatModelCatalogueError) {
      // features-service picked a model chat-service does not accept, or its catalogue is unreadable: ours, never the caller's.
      console.error("[content-generation-service] /preview-email model error:", error.message);
      return res.status(502).json({ error: error.message, code: error.code });
    }
    if (error instanceof BrandIntelError || error instanceof OfferGiveListsError) {
      // brand-service's own verdict on the brand (not found, several offers, bad
      // input, unscrapable site) is the caller's to act on; anything else is ours.
      const status = [400, 404, 409].includes(error.status) ? error.status
        : error.status === 402 ? 402
        : 502;
      console.error("[content-generation-service] /preview-email brand intel error:", error.message);
      return res.status(status).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[content-generation-service] /preview-email error:", error);
    traceEvent(runId, { service: "content-generation-service", event: "preview-email-error", detail: message, level: "error" }, req.headers).catch(() => {});
    res.status(500).json({ error: message });
  }
});

/**
 * POST /preview-email/prepare — "get ready to write preview emails for this brand".
 *
 * The onboarding knows the brand long before it asks for the first preview. This sends
 * brand-service, in the background, the same brand-intel request the preview will send
 * (src/lib/preview-warmup.ts), so the first POST /preview-email finds it cached and only
 * pays for the model. Answered 202 at once; the caller never waits for the site read.
 *
 * Idempotent: one warm-up per (org, brand) in flight, a completed one answers `ready` for
 * a while, and brand-service's own field cache makes any later repeat a cache read.
 * Billing: the brand-service call is the preview's own, moved earlier, billed by brand-
 * service to the calling org (x-org-id) like the preview's. No completion is made here.
 */
router.post("/preview-email/prepare", serviceAuth, (req: AuthenticatedRequest, res) => {
  const parsed = PreviewEmailPrepareRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  const { brandId, offerId } = parsed.data;
  const orgId = req.orgId!;
  const status = startPreviewWarmup({ orgId, userId: req.userId!, runId: req.runId!, brandId, offerId });
  traceEvent(req.runId!, { service: "content-generation-service", event: "preview-email-prepare", detail: `brandId=${brandId}, status=${status}` }, req.headers).catch(() => {});
  res.status(202).json({ brandId, status });
});

export default router;
