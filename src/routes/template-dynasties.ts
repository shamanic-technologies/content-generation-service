import { Router, Request, Response } from "express";
import {
  AddTemplateDynastyVersionRequestSchema,
  CreateTemplateDynastyRequestSchema,
  ListTemplateDynastiesQuerySchema,
  MergeTemplateDynastyRequestSchema,
  TemplateOutputsQuerySchema,
} from "../schemas.js";
import { TemplateDynastyError, UPGRADED_BY_SYSTEM } from "../lib/template-dynasties.js";
import { STAFF_EMAIL_HEADER } from "../lib/catalogue-status.js";
import {
  addDynastyVersion,
  createDynasty,
  getDynasty,
  listDynasties,
  mergeDynasty,
  readDynastyOutputs,
  resolveDynastyHead,
} from "../lib/template-dynasty-query.js";
import { templateWriteErrorResponse } from "../lib/template-neutrality.js";
import { formatPromptResponse } from "../lib/prompt-response.js";
import {
  TEMPLATE_DYNASTY_CREATE_SUPPORT,
  TEMPLATE_DYNASTY_VERSION_SUPPORT,
} from "../lib/platform-judgment-support.js";

/**
 * Template dynasties (TPL-DYNASTY-1021-CG): list, read, resolve the head, add a version, create
 * (over stored templates or from a new text).
 * API key only, no identity headers; cross-org catalogue. Rules: src/lib/template-dynasties.ts.
 */
const router = Router();

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof TemplateDynastyError) {
        return res.status(error.status).json(error.toResponseBody());
      }
      const refused = templateWriteErrorResponse(error);
      if (refused) return res.status(refused.status).json(refused.body);
      console.error(`[content-generation-service] ${req.method} ${req.path} error:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
    });
  };
}

function badRequest(res: Response, issues: Array<{ message: string; path: PropertyKey[] }>) {
  return res.status(400).json({ error: issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ") });
}

router.get("/internal/template-dynasties", handle(async (req, res) => {
  const parsed = ListTemplateDynastiesQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  res.json({ dynasties: await listDynasties(parsed.data) });
}));

router.post("/internal/template-dynasties", handle(async (req, res) => {
  const parsed = CreateTemplateDynastyRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const { versions, template, ...fields } = parsed.data;
  const orgId = req.header("x-org-id");
  res.status(201).json(await createDynasty(
    template ? { ...fields, template } : { ...fields, versions: versions! },
    // A new text is judged, billed to the platform; orgId is traceability only, like every prompts row.
    {
      orgId: orgId && /^[0-9a-f-]{36}$/i.test(orgId) ? orgId : null,
      caller: { mode: "platform", support: TEMPLATE_DYNASTY_CREATE_SUPPORT },
      // Older versions listed are deprecated "Upgraded" by whoever created the dynasty.
      changedBy: req.header(STAFF_EMAIL_HEADER)?.trim().toLowerCase() || UPGRADED_BY_SYSTEM,
    },
  ));
}));

router.get("/internal/template-dynasties/:slug", handle(async (req, res) => {
  res.json(await getDynasty(req.params.slug));
}));

router.get("/internal/template-dynasties/:slug/head", handle(async (req, res) => {
  const { dynasty, template } = await resolveDynastyHead(req.params.slug);
  res.json({ dynasty, template: formatPromptResponse(template) });
}));

router.get("/internal/template-dynasties/:slug/outputs", handle(async (req, res) => {
  const parsed = TemplateOutputsQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const { dynasty, outputs } = await readDynastyOutputs(req.params.slug, parsed.data.limit ?? 5);
  res.json({ slug: dynasty.slug, outputs });
}));

router.post("/internal/template-dynasties/:slug/versions", handle(async (req, res) => {
  const parsed = AddTemplateDynastyVersionRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const orgId = req.header("x-org-id");
  const { dynasty, template } = await addDynastyVersion({
    slug: req.params.slug,
    version: parsed.data,
    // Traceability only (who created the row), like every prompts row.
    orgId: orgId && /^[0-9a-f-]{36}$/i.test(orgId) ? orgId : null,
    caller: { mode: "platform", support: TEMPLATE_DYNASTY_VERSION_SUPPORT },
    // The previous head is deprecated "Upgraded" by whoever added this one.
    changedBy: req.header(STAFF_EMAIL_HEADER)?.trim().toLowerCase() || UPGRADED_BY_SYSTEM,
  });
  res.status(201).json({ dynasty, template: formatPromptResponse(template) });
}));

/**
 * Merge this dynasty INTO `into` (same pipe, same identity; MERGE-TEMPLATE-DYNASTY-1023). Staff only: the
 * api-service gateway decides who is staff and sends the verified `x-staff-email`, recorded as who merged.
 */
router.post("/internal/template-dynasties/:slug/merge", handle(async (req, res) => {
  const parsed = MergeTemplateDynastyRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const mergedBy = req.header(STAFF_EMAIL_HEADER)?.trim().toLowerCase();
  if (!mergedBy) {
    return res.status(400).json({ error: `${STAFF_EMAIL_HEADER} header is required: a merge records which staff member did it`, code: "MERGED_BY_REQUIRED" });
  }
  res.json(await mergeDynasty({ source: req.params.slug, into: parsed.data.into, reason: parsed.data.reason.trim(), mergedBy }));
}));

export default router;
