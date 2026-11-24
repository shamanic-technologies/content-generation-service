import { Router } from "express";
import { publicDir, publicFilePath } from "../lib/reels/media.js";

/**
 * GET /reels/:token/:file (REELS-1124): the ONE route mounted before `apiKeyAuth`. It serves a
 * rendered clip (Instagram's publish API fetches a public URL) or a source's audio (chat-service
 * fetches it to transcribe). The token (24+ random url-safe bytes) is the only secret; the file
 * is one of an allowlist; the resolved path must stay under `${MEDIA_DIR}/public`. Caddy proxies
 * `distribute.you/reels/*` here, so the path is exactly this one.
 */
const router = Router();

const CONTENT_TYPES: Record<string, string> = { "clip.mp4": "video/mp4" };

router.get("/reels/:token/:file", (req, res) => {
  const { token, file } = req.params;
  if (!publicFilePath(token, file)) return res.status(404).json({ error: "Not found" });
  // sendFile answers Range requests (206) and HEAD itself.
  // Relative to `root`: send's dotfile and traversal checks then apply to token/file only, not to MEDIA_DIR's own path.
  res.sendFile(
    `${token}/${file}`,
    {
      root: publicDir(),
      dotfiles: "deny",
      headers: { "Content-Type": CONTENT_TYPES[file], "Cache-Control": "public, max-age=86400", "X-Robots-Tag": "noindex" },
    },
    (err) => {
      if (!err) return;
      if (res.headersSent) return; // the client left mid-stream
      res.removeHeader("Cache-Control");
      res.status(404).json({ error: "Not found" });
    },
  );
});

export default router;
