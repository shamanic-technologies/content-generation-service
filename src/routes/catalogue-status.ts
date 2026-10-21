import { Router, Request, Response } from "express";
import { CHAT_MODELS, type ChatModel } from "../lib/chat-models.js";
import {
  listModelStatuses,
  listTemplateStatuses,
  readTemplateOutputs,
  setModelStatus,
  setTemplateStatus,
  templateExists,
} from "../lib/catalogue-status-query.js";
import { resolveStatusChange, STAFF_EMAIL_HEADER, type StatusChange } from "../lib/catalogue-status.js";
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

function isChatModel(value: string): value is ChatModel {
  return (CHAT_MODELS as readonly string[]).includes(value);
}

router.get("/internal/models", handle(async (_req: Request, res: Response) => {
  res.json({ models: await listModelStatuses() });
}));

router.put("/internal/models/:model/status", handle(async (req: Request, res: Response) => {
  const { model } = req.params;
  if (!isChatModel(model)) {
    return res.status(404).json({ error: `Unknown model alias "${model}". Accepted: ${CHAT_MODELS.join(", ")}` });
  }
  const change = parseStatusChange(req, res);
  if (!change) return;
  res.json(await setModelStatus(model, change));
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
