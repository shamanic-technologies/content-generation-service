import { Router, Request, Response } from "express";
import { z } from "zod";
import { put } from "@vercel/blob";
import { generateQuoteImage } from "../lib/quote-image.js";
import { composeSplitScreen } from "../lib/ffmpeg-compose.js";

const router = Router();

export const ComposeRequestSchema = z.object({
  videoUrl: z.string().url(),
  name: z.string(),
  age: z.number().int().positive(),
  theme: z.string(),
  text: z.string(),
  outputBlobToken: z.string(),
  layout: z.enum(["quote-top", "webcam-top"]).default("quote-top").optional(),
});

export type ComposeRequest = z.infer<typeof ComposeRequestSchema>;

router.post("/compose", async (req: Request, res: Response) => {
  const parsed = ComposeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  }

  const { videoUrl, name, age, theme, text, outputBlobToken, layout } = parsed.data;

  try {
    // 1. Download source video
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      return res.status(400).json({ error: `Failed to download video: ${videoResponse.status}` });
    }
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Detect extension from URL
    const urlPath = new URL(videoUrl).pathname;
    const videoExt = urlPath.split(".").pop() || "mp4";

    // 2. Generate quote image
    const imageBuffer = await generateQuoteImage({ name, age, theme, text });

    // 3. FFmpeg compose split-screen
    const composedBuffer = await composeSplitScreen({
      videoBuffer,
      imageBuffer,
      videoExt,
      layout,
    });

    // 4. Upload to Vercel Blob
    const blob = await put(
      `composed/${Date.now()}-${name.toLowerCase().replace(/\s+/g, "-")}.mp4`,
      composedBuffer,
      {
        access: "public",
        contentType: "video/mp4",
        token: outputBlobToken,
      },
    );

    return res.status(200).json({ composedVideoUrl: blob.url });
  } catch (err) {
    console.error("[compose] Error:", err);
    return res.status(500).json({ error: "Composition failed" });
  }
});

export default router;
