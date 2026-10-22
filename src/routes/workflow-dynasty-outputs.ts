import { Router } from "express";
import { WorkflowDynastyOutputsQuerySchema } from "../schemas.js";
import { readWorkflowDynastyOutputs } from "../lib/workflow-dynasty-outputs.js";

/**
 * GET /internal/workflow-dynasties/:slug/outputs (WF-RUNS-OUTPUTS-1022): the last emails one
 * workflow dynasty wrote, fleet-wide, each with its template and model. API key only.
 */
const router = Router();

router.get("/internal/workflow-dynasties/:slug/outputs", async (req, res) => {
  const parsed = WorkflowDynastyOutputsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  try {
    const outputs = await readWorkflowDynastyOutputs(req.params.slug, parsed.data.limit ?? 20);
    res.json({ slug: req.params.slug, outputs });
  } catch (error) {
    console.error(`[content-generation-service] GET ${req.path} error:`, error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Workflow dynasty outputs unavailable" });
  }
});

export default router;
