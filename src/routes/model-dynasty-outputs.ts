import { Router } from "express";
import { ModelDynastyOutputsQuerySchema } from "../schemas.js";
import { readModelDynastyOutputs } from "../lib/model-dynasty-outputs.js";

/**
 * GET /internal/model-dynasties/:slug/outputs?featureSlug=&legKey= (MODEL-OUTPUTS-1024-CG): the last
 * messages one LLM dynasty wrote on one pipe, fleet-wide, each with its template, model version and
 * tokens. API key only.
 */
const router = Router();

router.get("/internal/model-dynasties/:slug/outputs", async (req, res) => {
  const parsed = ModelDynastyOutputsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  try {
    const { name, modelIds, outputs } = await readModelDynastyOutputs({
      slug: req.params.slug,
      featureSlug: parsed.data.featureSlug,
      legKey: parsed.data.legKey,
      limit: parsed.data.limit ?? 5,
    });
    res.json({ slug: req.params.slug, name, featureSlug: parsed.data.featureSlug, legKey: parsed.data.legKey, modelIds, outputs });
  } catch (error) {
    const status = (error as { status?: number }).status === 404 ? 404 : 502;
    console.error(`[content-generation-service] GET ${req.path} error:`, error);
    res.status(status).json({
      error: error instanceof Error ? error.message : "Model dynasty outputs unavailable",
      ...((error as { code?: string }).code ? { code: (error as { code?: string }).code } : {}),
    });
  }
});

export default router;
