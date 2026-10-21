import { Router, Request, Response } from "express";
import {
  AddTemplateDynastyVersionRequestSchema,
  CreateTemplateDynastyRequestSchema,
  ListTemplateDynastiesQuerySchema,
} from "../schemas.js";
import { TemplateDynastyError } from "../lib/template-dynasties.js";
import {
  addDynastyVersion,
  createDynasty,
  getDynasty,
  listDynasties,
  resolveDynastyHead,
} from "../lib/template-dynasty-query.js";
import { templateWriteErrorResponse } from "../lib/template-neutrality.js";
import { formatPromptResponse } from "../lib/prompt-response.js";

/**
 * Template dynasties (TPL-DYNASTY-1021-CG): list, read, resolve the head, add a version.
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
  res.status(201).json(await createDynasty(parsed.data));
}));

router.get("/internal/template-dynasties/:slug", handle(async (req, res) => {
  res.json(await getDynasty(req.params.slug));
}));

router.get("/internal/template-dynasties/:slug/head", handle(async (req, res) => {
  const { dynasty, template } = await resolveDynastyHead(req.params.slug);
  res.json({ dynasty, template: formatPromptResponse(template) });
}));

router.post("/internal/template-dynasties/:slug/versions", handle(async (req, res) => {
  const parsed = AddTemplateDynastyVersionRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const orgId = req.header("x-org-id");
  const { dynasty, template } = await addDynastyVersion({
    slug: req.params.slug,
    prompt: parsed.data.prompt,
    variables: parsed.data.variables,
    // Traceability only (who created the row), like every prompts row.
    orgId: orgId && /^[0-9a-f-]{36}$/i.test(orgId) ? orgId : null,
    caller: { mode: "platform" },
  });
  res.status(201).json({ dynasty, template: formatPromptResponse(template) });
}));

export default router;
