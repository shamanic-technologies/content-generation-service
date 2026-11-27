import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAFE_VIDEO_DEMUXERS, SAFE_VIDEO_INPUT_OPTIONS } from "../../src/lib/ffmpeg-input.js";
import { assertPublicHost, downloadSource } from "../../src/lib/reels/download.js";

// SSRF-1127: a caller's bytes never make ffmpeg/ffprobe open a URL, and a reels source URL
// never reaches a non-public address.

describe("ffmpeg input guard", () => {
  it("allows the local file protocol only", () => {
    const i = SAFE_VIDEO_INPUT_OPTIONS.indexOf("-protocol_whitelist");
    expect(SAFE_VIDEO_INPUT_OPTIONS[i + 1]).toBe("file");
  });

  it("allows no playlist / list / description demuxer", () => {
    const names = SAFE_VIDEO_DEMUXERS.split(",");
    for (const banned of ["hls", "applehttp", "concat", "sdp", "rtsp", "rtp", "image2", "lavfi", "ffconcat", "dash", "data", "tee"]) {
      expect(names).not.toContain(banned);
    }
  });

  const hasFfprobe = spawnSync("ffprobe", ["-version"]).status === 0;

  describe.skipIf(!hasFfprobe)("real ffprobe (skipped where ffmpeg is not installed)", () => {
    let server: Server;
    let hits = 0;
    let dir: string;
    beforeAll(async () => {
      server = createServer((_req, res) => {
        hits++;
        res.end("x");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      dir = mkdtempSync(join(tmpdir(), "ssrf-1127-"));
    });
    afterAll(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("refuses an HLS playlist pointing at an internal address, without dialling it", () => {
      const port = (server.address() as AddressInfo).port;
      const playlist = join(dir, "source.m3u8");
      writeFileSync(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${port}/segment.ts\n#EXT-X-ENDLIST\n`);
      const r = spawnSync("ffprobe", ["-v", "error", ...SAFE_VIDEO_INPUT_OPTIONS, "-show_entries", "format=duration", "-of", "csv=p=0", playlist]);
      expect(r.status).not.toBe(0);
      expect(r.stderr.toString()).toMatch(/not on whitelist|Invalid/);
      expect(hits).toBe(0);
    });

    it("still reads a real mp4", () => {
      const mp4 = join(dir, "ok.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=1:s=64x64", "-pix_fmt", "yuv420p", mp4]);
      const out = execFileSync("ffprobe", ["-v", "error", ...SAFE_VIDEO_INPUT_OPTIONS, "-show_entries", "format=duration", "-of", "csv=p=0", mp4]);
      expect(parseFloat(out.toString())).toBeGreaterThan(0.5);
    });
  });
});

describe("reels source URL guard", () => {
  it.each(["127.0.0.1", "localhost", "key-service", "windmill-server", "10.0.0.5", "172.17.0.1", "169.254.169.254", "[::1]", "[::ffff:7f00:1]", "62.83.93.230"])(
    "assertPublicHost(%s) -> SOURCE_URL_FORBIDDEN",
    async (host) => {
      await expect(assertPublicHost(host)).rejects.toMatchObject({ code: "SOURCE_URL_FORBIDDEN" });
    },
  );

  it("downloadSource refuses a private https source before any connection", async () => {
    const media = mkdtempSync(join(tmpdir(), "ssrf-1127-media-"));
    const before = process.env.MEDIA_DIR;
    process.env.MEDIA_DIR = media;
    try {
      await expect(downloadSource("v-ssrf", "https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "SOURCE_URL_FORBIDDEN" });
      await expect(downloadSource("v-ssrf", "https://key-service:8080/internal")).rejects.toMatchObject({ code: "SOURCE_URL_FORBIDDEN" });
    } finally {
      process.env.MEDIA_DIR = before;
      rmSync(media, { recursive: true, force: true });
    }
  });
});
