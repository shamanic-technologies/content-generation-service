import { Router, Request, Response } from "express";
import { ChatModelCatalogueError, findChatModel, listChatModels } from "../lib/chat-model-catalogue.js";
import { listModelStatuses, setModelStatus, type ModelStatusEntry } from "../lib/catalogue-status-query.js";
import { resolveStatusChange, STAFF_EMAIL_HEADER } from "../lib/catalogue-status.js";
import { assertEngine, EngineCatalogueError } from "../lib/engine-catalogue.js";
import { readEngineModelOutputs } from "../lib/engine-model-outputs.js";
import { ModelDynastyCatalogueError, ModelDynastyNotFoundError } from "../lib/model-dynasty-client.js";
import { EngineModelOutputsQuerySchema, SetCatalogueStatusRequestSchema } from "../schemas.js";

/**
 * Writer models read and set per ENGINE (RESEARCH-BY-ENGINE-1113-CG): staff Research > an Engine > LLMs.
 * API key only, no identity headers (the staff gateway decides who is staff).
 *
 * - GET  /internal/engines/:engine/models: every writer model name with its status on that Engine.
 * - PUT  /internal/engines/:engine/models/:model/status: set it (the whole LLM dynasty, that Engine only).
 * - GET  /internal/engines/:engine/model-dynasties/:slug/outputs: the last messages that LLM wrote for that Engine.
 * The Engine is checked against features-service's catalogue (404 `UNKNOWN_ENGINE`, 502 `ENGINE_CATALOGUE_UNAVAILABLE`).
 * No field, param or enum names a pipe, leg, channel, play or workflow.
 */
const router = Router();

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof EngineCatalogueError) return res.status(error.status).json(error.toResponseBody());
      if (error instanceof ModelDynastyNotFoundError) return res.status(404).json({ error: error.message, code: error.code });
      if (error instanceof ModelDynastyCatalogueError) return res.status(502).json({ error: error.message, code: error.code });
      if (error instanceof ChatModelCatalogueError) return res.status(502).json({ error: error.message, code: error.code });
      console.error(`[content-generation-service] ${req.method} ${req.path} error:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
    });
  };
}

/** One model on one Engine, in Engine words. */
const onEngine = ({ model, provider, dynasty, status, statusReason, statusChangedBy, statusChangedAt }: ModelStatusEntry) => ({
  model,
  provider,
  dynasty,
  status,
  statusReason,
  statusChangedBy,
  statusChangedAt,
});

router.get("/internal/engines/:engine/models", handle(async (req, res) => {
  const engine = await assertEngine(req.params.engine);
  res.json({ engine, models: (await listModelStatuses(engine)).map(onEngine) });
}));

router.put("/internal/engines/:engine/models/:model/status", handle(async (req, res) => {
  const parsed = SetCatalogueStatusRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
  const change = resolveStatusChange(parsed.data.status, parsed.data.reason, req.header(STAFF_EMAIL_HEADER));
  if ("code" in change) return res.status(400).json(change);
  const { model } = req.params;
  const entry = await findChatModel(model);
  if (!entry) {
    const accepted = (await listChatModels()).map((e) => e.model);
    return res.status(404).json({ error: `Unknown model "${model}". chat-service accepts: ${accepted.join(", ")}` });
  }
  const engine = await assertEngine(req.params.engine);
  res.json({ engine, ...onEngine(await setModelStatus(entry, engine, change)) });
}));

router.get("/internal/engines/:engine/model-dynasties/:slug/outputs", handle(async (req, res) => {
  const parsed = EngineModelOutputsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  const engine = await assertEngine(req.params.engine);
  const { name, modelIds, outputs } = await readEngineModelOutputs({ engine, slug: req.params.slug, limit: parsed.data.limit ?? 5 });
  res.json({ engine, slug: req.params.slug, name, modelIds, outputs });
}));

export default router;
