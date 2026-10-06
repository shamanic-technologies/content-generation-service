import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailPreviews, prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { generateFromTemplate, InsufficientCreditsError } from "../lib/chat-service-client.js";
import { fetchBrandIntel, fetchBrandRows, BrandIntelError, BrandRowsError } from "../lib/brand-client.js";
import { fetchOfferGiveLists, OfferGiveListsError } from "../lib/offer-give-lists-client.js";
import { extractTemplateVariableNames } from "../lib/template-vars.js";
import { IncompleteSequenceError } from "../lib/sequence-delays.js";
import { traceEvent } from "../lib/trace-event.js";
import { resolvePreviewWorkflow } from "../lib/preview-workflow-client.js";
import { PreviewWorkflowError, planNeedsBrandRows, resolvePreviewVariables } from "../lib/preview-workflow.js";
import {
  BRAND_INTEL_FIELDS,
  buildPreviewContext,
  previewRecipientKey,
  type PreviewRecipient,
} from "../lib/preview-email.js";
import {
  PREVIEW_ANNOTATION_VERSION,
  buildHighlightSources,
  resolveHighlights,
  type PreviewHighlight,
} from "../lib/preview-highlights.js";
import { PreviewEmailRequestSchema } from "../schemas.js";

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
    // Which workflow's template + model wrote it. Null on rows stored before the preview
    // followed the best mature workflow.
    promptType: row.promptType,
    modelAlias: row.modelAlias ?? null,
    workflowSlug: row.workflowSlug ?? null,
    highlights: (row.highlights as PreviewHighlight[] | null) ?? null,
    cached,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

function isPreviewDuplicateError(err: unknown): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown };
  return e?.code === "23505" && e?.constraint_name === "idx_email_previews_recipient";
}

/**
 * POST /preview-email — ONE cold email for a brand of the calling org and a sample
 * recipient, written before any campaign or lead exists (the signed-out onboarding's
 * last screen). It is written with the template + model of the fleet's best MATURE
 * cold-email workflow, read at request time (src/lib/preview-workflow.ts): the email the
 * visitor would receive once they pay. No fallback template or model: an unreadable
 * ranking fails the request.
 *
 * Billing: the only paid call is the chat-service completion, which provisions,
 * authorizes and declares the LLM cost against the calling org (x-org-id) itself — the
 * same path every /generate takes. An org that cannot afford it is answered 402.
 *
 * Nothing sendable: no campaign, no lead, and no email_generations row. The result is
 * stored in email_previews, which only this route reads, so a repeat call for the same
 * brand + recipient returns it without a second completion.
 */
router.post("/preview-email", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const runId = req.runId!;
  try {
    const parsed = PreviewEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
    }
    if (req.body && typeof req.body === "object" && "model" in req.body) {
      return res.status(400).json({ error: "model: not accepted; the preview writes with the model of the best mature cold-email workflow" });
    }
    const { brandId, recipient, audience, offerId } = parsed.data;
    const orgId = req.orgId!;
    const identity = { orgId, userId: req.userId!, runId, brandId, offerId };

    // The offer's confirmed give lists shape the email (its ask, and what it must never
    // offer), so they are read first and are part of the stored preview's identity.
    // A plain read, nothing billed; a refusal fails the preview like its brand intel does.
    const giveLists = await fetchOfferGiveLists(identity);

    // The best mature cold-email workflow's template + model (cached a few minutes). Part
    // of the stored preview's identity, so a new best workflow writes a new preview.
    const plan = await resolvePreviewWorkflow(identity);
    const model = plan.model;

    const recipientKey = previewRecipientKey({ recipient, audience, offerId, promptType: plan.promptType, model, workflowSlug: plan.workflowSlug, annotationVersion: PREVIEW_ANNOTATION_VERSION, giveLists });
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

    // The same brand-service request the workflow's own brand-extract-fields node sends; it
    // is also the check that brandId is a brand of this org, and it carries the brand's name.
    const intel = await fetchBrandIntel(plan.brandIntelFields ?? BRAND_INTEL_FIELDS, identity);
    const brandName = intel.brands[0]?.name;
    if (!brandName) {
      throw new Error(`brand-service returned no brand for brandId=${brandId}`);
    }

    // The brand rows the workflow's brands-fetch / brand-profile nodes read, when its
    // template is fed from them.
    const brands = planNeedsBrandRows(plan) ? await fetchBrandRows(brandId, identity) : null;

    const storedPrompt = await db.query.prompts.findFirst({ where: eq(prompts.type, plan.promptType) });
    if (!storedPrompt) {
      throw new Error(`Preview prompt type=${plan.promptType} (workflow ${plan.workflowSlug}) is not registered`);
    }

    const variables = resolvePreviewVariables(
      plan,
      { recipient, brandIntel: intel as unknown as Record<string, unknown>, brands, currentDate: new Date().toISOString().split("T")[0] },
      extractTemplateVariableNames(storedPrompt.prompt)
    );

    // Everything the email could rest on, from the inputs actually sent. The same
    // completion reports which of these each sentence uses; no second call.
    const sources = buildHighlightSources({ recipient, audience, brandName, brandFields: intel.fields ?? {}, giveForFree: giveLists?.giveForFree });

    traceEvent(runId, { service: "content-generation-service", event: "preview-email-start", detail: `brandId=${brandId}, workflow=${plan.workflowSlug}, type=${plan.promptType}, model=${model}` }, req.headers).catch(() => {});
    const result = await generateFromTemplate(
      {
        promptTemplate: storedPrompt.prompt,
        variables,
        campaignContext: buildPreviewContext(audience),
        model,
        giveLists,
        annotate: { sources: sources.map((s) => ({ id: s.id, label: s.label })) },
        // No reasoning override: /generate sends none, so the preview writes exactly as a
        // campaign run does. Latency is not a constraint here (owner 2026-10-06).
      },
      identity
    );

    const first = result.sequence[0];
    if (!first || !first.bodyText) {
      throw new Error(`Model returned no email body for preview (brandId=${brandId})`);
    }

    const rawHighlights = result.highlights ?? [];
    const highlights = resolveHighlights(rawHighlights, first.bodyText, sources);
    if (highlights.length < rawHighlights.length) {
      console.warn(`[content-generation-service] /preview-email dropped ${rawHighlights.length - highlights.length}/${rawHighlights.length} highlights that were not verbatim in the body or named an input that was not sent (brandId=${brandId})`);
    }

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
          workflowSlug: plan.workflowSlug,
          subject: result.subject,
          bodyText: first.bodyText,
          bodyHtml: first.bodyHtml,
          sequence: result.sequence,
          model: result.model,
          tokensInput: result.tokensInput,
          tokensOutput: result.tokensOutput,
          promptRaw: result.promptRaw,
          responseRaw: result.responseRaw,
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

    traceEvent(runId, { service: "content-generation-service", event: "preview-email-done", detail: `previewId=${row.id}, model=${result.model}, highlights=${highlights.length}/${rawHighlights.length}, tokensIn=${result.tokensInput}, tokensOut=${result.tokensOutput}` }, req.headers).catch(() => {});
    res.json(toPreviewResponse(row, false));
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return res.status(402).json({
        error: "Insufficient credits",
        balance_cents: error.balance_cents,
        required_cents: error.required_cents,
      });
    }
    if (error instanceof PreviewWorkflowError) {
      // The ranking or the winning workflow could not be read: there is no fallback
      // template or model, so the preview is refused rather than written by anything else.
      console.error("[content-generation-service] /preview-email workflow error:", error.message);
      traceEvent(runId, { service: "content-generation-service", event: "preview-email-error", detail: error.message, level: "error" }, req.headers).catch(() => {});
      return res.status(error.status).json({ error: error.message });
    }
    if (error instanceof BrandIntelError || error instanceof BrandRowsError || error instanceof OfferGiveListsError) {
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
    const status = error instanceof IncompleteSequenceError || message.startsWith("chat-service") ? 502 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
