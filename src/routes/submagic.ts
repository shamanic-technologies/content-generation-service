import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, serviceAuth } from "../middleware/auth.js";
import { decryptKey } from "../lib/key-client.js";
import {
  createProject,
  pollProjectCompletion,
  triggerExport,
  pollExportUrl,
} from "../lib/submagic-client.js";
import { uploadToStorage } from "../lib/storage-client.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

export const SubmagicProcessRequestSchema = z.object({
  composedVideoUrl: z.string().url(),
  title: z.string(),
  templateName: z.string(),
  language: z.string(),
  magicZooms: z.boolean(),
  magicBrolls: z.boolean(),
  magicBrollsPercentage: z.number().int().min(0).max(100),
  removeBadTakes: z.boolean(),
  removeSilencePace: z.string(),
  cleanAudio: z.boolean(),
  exportWidth: z.number().int().positive(),
  exportHeight: z.number().int().positive(),
  exportFps: z.number().int().positive(),
});

export type SubmagicProcessRequest = z.infer<typeof SubmagicProcessRequestSchema>;

router.post("/submagic/process", serviceAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = SubmagicProcessRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }

  const {
    composedVideoUrl,
    title,
    templateName,
    language,
    magicZooms,
    magicBrolls,
    magicBrollsPercentage,
    removeBadTakes,
    removeSilencePace,
    cleanAudio,
    exportWidth,
    exportHeight,
    exportFps,
  } = parsed.data;

  try {
    traceEvent(req.runId!, { service: "content-generation-service", event: "submagic-start", detail: `title=${title}, template=${templateName}, language=${language}` }, req.headers).catch(() => {});

    // Resolve Submagic API key via key-service
    const { key: submagicApiKey } = await decryptKey(
      "submagic",
      req.orgId!,
      req.userId!,
      {
        callerMethod: "POST",
        callerPath: "/submagic/process",
        campaignId: req.campaignId,
        brandId: req.brandId,
        workflowSlug: req.workflowSlug,
        featureSlug: req.featureSlug,
      },
    );

    traceEvent(req.runId!, { service: "content-generation-service", event: "submagic-key-resolved", detail: "Decrypted submagic API key via key-service" }, req.headers).catch(() => {});

    // 1. Create Submagic project
    console.log("[submagic] Creating project:", title);
    const { id: projectId } = await createProject(submagicApiKey, {
      composedVideoUrl,
      title,
      templateName,
      language,
      magicZooms,
      magicBrolls,
      magicBrollsPercentage,
      removeBadTakes,
      removeSilencePace,
      cleanAudio,
    });
    console.log("[submagic] Project created:", projectId);
    traceEvent(req.runId!, { service: "content-generation-service", event: "submagic-project-created", detail: `projectId=${projectId}` }, req.headers).catch(() => {});

    // 2. Poll until project is completed
    console.log("[submagic] Polling for completion...");
    await pollProjectCompletion(submagicApiKey, projectId);
    console.log("[submagic] Project completed");

    // 3. Trigger export
    console.log("[submagic] Triggering export...");
    await triggerExport(submagicApiKey, projectId, {
      width: exportWidth,
      height: exportHeight,
      fps: exportFps,
    });
    console.log("[submagic] Export triggered");

    // 4. Poll for export URL
    console.log("[submagic] Polling for export URL...");
    const { videoUrl: submagicVideoUrl } = await pollExportUrl(submagicApiKey, projectId);
    console.log("[submagic] Export ready:", submagicVideoUrl);
    traceEvent(req.runId!, { service: "content-generation-service", event: "submagic-export-ready", detail: `projectId=${projectId}, exportUrl=${submagicVideoUrl}` }, req.headers).catch(() => {});

    // 5. Re-upload to persistent R2 storage via cloudflare-storage-service
    console.log("[submagic] Uploading to persistent storage...");
    const { url: permanentVideoUrl } = await uploadToStorage(
      {
        sourceUrl: submagicVideoUrl,
        folder: "videos",
        filename: `${projectId}.mp4`,
        contentType: "video/mp4",
      },
      {
        orgId: req.orgId!,
        userId: req.userId!,
        runId: req.runId!,
        campaignId: req.campaignId,
        brandId: req.brandId,
        workflowSlug: req.workflowSlug,
        featureSlug: req.featureSlug,
      },
    );
    console.log("[submagic] Stored permanently:", permanentVideoUrl);

    traceEvent(req.runId!, { service: "content-generation-service", event: "submagic-done", detail: `projectId=${projectId}, permanentUrl=${permanentVideoUrl}` }, req.headers).catch(() => {});

    return res.status(200).json({
      projectId,
      videoUrl: permanentVideoUrl,
      previewUrl: `https://app.submagic.co/view/${projectId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[submagic] Processing failed:", message);
    if (req.runId) {
      traceEvent(req.runId, { service: "content-generation-service", event: "submagic-error", detail: message, level: "error" }, req.headers).catch(() => {});
    }
    return res.status(502).json({
      error: "Submagic processing failed",
      reason: message,
    });
  }
});

export default router;
