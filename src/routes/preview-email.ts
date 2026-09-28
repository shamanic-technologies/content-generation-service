import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailPreviews, prompts } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { generateFromTemplate, InsufficientCreditsError } from "../lib/chat-service-client.js";
import { fetchBrandIntel, BrandIntelError } from "../lib/brand-client.js";
import { extractTemplateVariableNames } from "../lib/template-vars.js";
import { DEFAULT_MODEL } from "../lib/chat-models.js";
import { IncompleteSequenceError } from "../lib/sequence-delays.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  PREVIEW_PROMPT_TYPE,
  BRAND_INTEL_FIELDS,
  buildPreviewVariables,
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
 * last screen). See src/lib/preview-email.ts for why this is the product's real writing.
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
    const { brandId, recipient, audience, offerId } = parsed.data;
    const model = parsed.data.model ?? DEFAULT_MODEL;
    const orgId = req.orgId!;
    const identity = { orgId, userId: req.userId!, runId, brandId, offerId };

    const recipientKey = previewRecipientKey({ recipient, audience, offerId, promptType: PREVIEW_PROMPT_TYPE, model, annotationVersion: PREVIEW_ANNOTATION_VERSION });
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

    // The same brand-service request the live cold-email workflows send; it is also the
    // check that brandId is a brand of this org, and it carries the brand's name.
    const intel = await fetchBrandIntel(BRAND_INTEL_FIELDS, identity);
    const brandName = intel.brands[0]?.name;
    if (!brandName) {
      throw new Error(`brand-service returned no brand for brandId=${brandId}`);
    }

    const storedPrompt = await db.query.prompts.findFirst({ where: eq(prompts.type, PREVIEW_PROMPT_TYPE) });
    if (!storedPrompt) {
      throw new Error(`Preview prompt type=${PREVIEW_PROMPT_TYPE} is not registered`);
    }

    const variables = buildPreviewVariables(
      recipient,
      brandName,
      intel,
      extractTemplateVariableNames(storedPrompt.prompt)
    );

    // Everything the email could rest on, from the inputs actually sent. The same
    // completion reports which of these each sentence uses; no second call.
    const sources = buildHighlightSources({ recipient, audience, brandName, brandFields: intel.fields ?? {} });

    traceEvent(runId, { service: "content-generation-service", event: "preview-email-start", detail: `brandId=${brandId}, type=${PREVIEW_PROMPT_TYPE}, model=${model}` }, req.headers).catch(() => {});
    const result = await generateFromTemplate(
      {
        promptTemplate: storedPrompt.prompt,
        variables,
        campaignContext: buildPreviewContext(audience),
        model,
        annotate: { sources: sources.map((s) => ({ id: s.id, label: s.label })) },
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
          promptType: PREVIEW_PROMPT_TYPE,
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
    if (error instanceof BrandIntelError) {
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
