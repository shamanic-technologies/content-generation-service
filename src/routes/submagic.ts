import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  createProject,
  pollProjectCompletion,
  triggerExport,
  pollExportUrl,
} from "../lib/submagic-client.js";

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

router.post("/submagic/process", async (req: Request, res: Response) => {
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
    // 1. Create Submagic project
    console.log("[submagic] Creating project:", title);
    const { id: projectId } = await createProject({
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

    // 2. Poll until project is completed
    console.log("[submagic] Polling for completion...");
    await pollProjectCompletion(projectId);
    console.log("[submagic] Project completed");

    // 3. Trigger export
    console.log("[submagic] Triggering export...");
    await triggerExport(projectId, {
      width: exportWidth,
      height: exportHeight,
      fps: exportFps,
    });
    console.log("[submagic] Export triggered");

    // 4. Poll for export URL
    console.log("[submagic] Polling for export URL...");
    const { videoUrl } = await pollExportUrl(projectId);
    console.log("[submagic] Export ready:", videoUrl);

    return res.status(200).json({
      projectId,
      videoUrl,
      previewUrl: `https://app.submagic.co/view/${projectId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[submagic] Processing failed:", message);
    return res.status(502).json({
      error: "Submagic processing failed",
      reason: message,
    });
  }
});

export default router;
