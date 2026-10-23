import { Router, Request, Response } from "express";
import { ChatModelCatalogueError, findChatModel, listChatModels } from "../lib/chat-model-catalogue.js";
import {
  listModelStatuses,
  listTemplateStatuses,
  readTemplateOutputs,
  setModelStatus,
  setTemplateStatus,
  templateExists,
} from "../lib/catalogue-status-query.js";
import { resolveModelPipe, resolveStatusChange, STAFF_EMAIL_HEADER, type StatusChange } from "../lib/catalogue-status.js";
import { SetCatalogueStatusRequestSchema, TemplateOutputsQuerySchema } from "../schemas.js";
import { assertMayActivate } from "../lib/dynasty-membership.js";
import { TemplateDynastyError } from "../lib/template-dynasties.js";

/**
 * Staff catalogue status of templates and writer models + a template's last outputs
 * (TEMPLATE-MODEL-STATUS-1019). API key only, no identity headers: the staff gateway
 * (api-service) is who decides a caller is staff. See src/lib/catalogue-status.ts.
 */
const router = Router();

/** Express 4 does not catch a rejected async handler: answer 500, logged, never hang. */
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof TemplateDynastyError) return res.status(error.status).json(error.toResponseBody());
      if (error instanceof ChatModelCatalogueError) return res.status(502).json({ error: error.message, code: error.code });
      console.error(`[content-generation-service] ${req.method} ${req.path} error:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
    });
  };
}

/** Body + who → a valid change, or the 400 already sent. A deprecation must say why and who. */
function parseStatusChange(req: Request, res: Response): StatusChange | null {
  const parsed = SetCatalogueStatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    return null;
  }
  const change = resolveStatusChange(parsed.data.status, parsed.data.reason, req.header(STAFF_EMAIL_HEADER));
  if ("code" in change) {
    res.status(400).json(change);
    return null;
  }
  return change;
}

router.get("/internal/models", handle(async (req: Request, res: Response) => {
  const pipe = resolveModelPipe(req.query.featureSlug, req.query.legKey);
  if (pipe && "code" in pipe) return res.status(400).json(pipe);
  res.json({ models: await listModelStatuses(pipe) });
}));

router.put("/internal/models/:model/status", handle(async (req: Request, res: Response) => {
  const { model } = req.params;
  const entry = await findChatModel(model);
  if (!entry) {
    const accepted = (await listChatModels()).map((e) => e.model);
    return res.status(404).json({ error: `Unknown model "${model}". chat-service accepts: ${accepted.join(", ")}` });
  }
  const change = parseStatusChange(req, res);
  if (!change) return;
  // A model's status is per pipe (LLM-STATUS-PER-PIPE-1023): never a fleet-wide retirement.
  const pipe = resolveModelPipe(req.body?.featureSlug, req.body?.legKey);
  if (!pipe) {
    return res.status(400).json({
      code: "PIPE_REQUIRED",
      error: "A model's status is set on ONE pipe: send `featureSlug` and `legKey` (e.g. sales-cold-email-outreach + lead_found_to_website_visit).",
    });
  }
  if ("code" in pipe) return res.status(400).json(pipe);
  res.json(await setModelStatus(entry, pipe, change));
}));

router.get("/internal/templates", handle(async (_req: Request, res: Response) => {
  res.json({ templates: await listTemplateStatuses() });
}));

router.put("/internal/templates/:type/status", handle(async (req: Request, res: Response) => {
  const change = parseStatusChange(req, res);
  if (!change) return;
  // Only a dynasty's head may be Active (TPL-DYNASTY-ROWS-1021-CG): 409 NOT_DYNASTY_HEAD otherwise.
  if (change.status === "active") await assertMayActivate(req.params.type);
  const entry = await setTemplateStatus(req.params.type, change);
  if (!entry) {
    return res.status(404).json({ error: `No template found for type=${req.params.type}` });
  }
  res.json(entry);
}));

router.get("/internal/templates/:type/outputs", handle(async (req: Request, res: Response) => {
  const parsed = TemplateOutputsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
  }
  const { type } = req.params;
  if (!(await templateExists(type))) {
    return res.status(404).json({ error: `No template found for type=${type}` });
  }
  res.json({ type, outputs: await readTemplateOutputs(type, parsed.data.limit ?? 5) });
}));

export default router;
