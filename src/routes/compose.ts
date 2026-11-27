import { Router, Request, Response } from "express";
import { z } from "zod";
import { put } from "@vercel/blob";
import { generateQuoteImage } from "../lib/quote-image.js";
import { composeSplitScreen } from "../lib/ffmpeg-compose.js";
import { readCappedBody, PayloadTooLargeError } from "../lib/capped-body.js";
import { publicFetch, PublicUrlRefusedError } from "../lib/safe-fetch.js";

const router = Router();

/**
 * Ceiling on the source video held in memory. The download, the composed output
 * and the blob upload are all buffered whole, so an arbitrarily large `videoUrl`
 * was an unbounded allocation on a ~2 GB heap.
 */
export const MAX_SOURCE_VIDEO_BYTES = 150 * 1024 * 1024;

/** A source that sends nothing for this long is dead. */
export const SOURCE_VIDEO_TIMEOUT_MS = 120_000;

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
    // 1. Download source video. `videoUrl` is the CALLER's (gateway, any user key, MCP):
    // https only, every hop (redirects included) public and pinned (SSRF-1127). A refusal
    // or a failed download never echoes what the target answered.
    let videoResponse: globalThis.Response;
    try {
      videoResponse = await publicFetch(videoUrl, {
        protocols: ["https:"],
        signal: AbortSignal.timeout(SOURCE_VIDEO_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof PublicUrlRefusedError) {
        console.warn(`[compose] videoUrl refused: not a public https address`);
        return res.status(400).json({ error: `videoUrl refused: ${err.message}`, code: "VIDEO_URL_NOT_PUBLIC" });
      }
      console.error(`[compose] videoUrl unreachable: ${(err as Error).message}`);
      return res.status(400).json({ error: "Could not download the video from videoUrl", code: "VIDEO_DOWNLOAD_FAILED" });
    }
    if (!videoResponse.ok) {
      await videoResponse.body?.cancel().catch(() => undefined);
      console.error(`[compose] videoUrl answered ${videoResponse.status}`);
      return res.status(400).json({ error: "Could not download the video from videoUrl", code: "VIDEO_DOWNLOAD_FAILED" });
    }
    let videoBuffer: Buffer;
    try {
      videoBuffer = await readCappedBody(videoResponse, MAX_SOURCE_VIDEO_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        console.error(`[compose] Source video over the ${MAX_SOURCE_VIDEO_BYTES} byte limit: ${err.message}`);
        return res.status(413).json({
          error: `Source video exceeds the ${MAX_SOURCE_VIDEO_BYTES} byte limit`,
          maxBytes: MAX_SOURCE_VIDEO_BYTES,
        });
      }
      throw err;
    }
    console.log(`[compose] Downloaded source video: ${videoBuffer.byteLength} bytes`);

    // 2. Generate quote image
    const imageBuffer = await generateQuoteImage({ name, age, theme, text });

    // 3. FFmpeg compose split-screen
    const composedBuffer = await composeSplitScreen({
      videoBuffer,
      imageBuffer,
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
