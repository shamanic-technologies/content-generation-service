import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock dependencies before importing the route
vi.mock("../../src/lib/quote-image.js", () => ({
  generateQuoteImage: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
}));

vi.mock("../../src/lib/ffmpeg-compose.js", () => ({
  composeSplitScreen: vi.fn().mockResolvedValue(Buffer.from("fake-mp4")),
}));

vi.mock("@vercel/blob", () => ({
  put: vi.fn().mockResolvedValue({ url: "https://blob.vercel-storage.com/composed/output.mp4" }),
}));

// Mock global fetch for video download
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import composeRoutes from "../../src/routes/compose.js";
import { generateQuoteImage } from "../../src/lib/quote-image.js";
import { composeSplitScreen } from "../../src/lib/ffmpeg-compose.js";
import { put } from "@vercel/blob";

const VALID_KEY = "test-key";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Simulate apiKeyAuth
  app.use((req, res, next) => {
    const key = req.headers["x-api-key"];
    if (key !== VALID_KEY) return res.status(401).json({ error: "Unauthorized" });
    next();
  });
  app.use(composeRoutes);
  return app;
}

const validBody = {
  videoUrl: "https://example.com/video.mp4",
  name: "Sophie",
  age: 34,
  theme: "Loss of Desire",
  text: "I used to feel everything so deeply.",
  outputBlobToken: "vercel_blob_token_123",
};

describe("POST /compose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
  });

  it("returns 400 when required fields are missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send({ videoUrl: "https://example.com/video.mp4" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when videoUrl is not a valid URL", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send({ ...validBody, videoUrl: "not-a-url" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when age is not a positive integer", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send({ ...validBody, age: -5 })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when video download fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const app = buildApp();
    const res = await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(400);

    expect(res.body.error).toMatch(/Failed to download video/);
  });

  it("composes video and returns blob URL on success", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(200);

    expect(res.body.composedVideoUrl).toBe("https://blob.vercel-storage.com/composed/output.mp4");

    // Verify pipeline was called correctly
    expect(mockFetch).toHaveBeenCalledWith(validBody.videoUrl);
    expect(generateQuoteImage).toHaveBeenCalledWith({
      name: "Sophie",
      age: 34,
      theme: "Loss of Desire",
      text: "I used to feel everything so deeply.",
    });
    expect(composeSplitScreen).toHaveBeenCalledWith({
      videoBuffer: expect.any(Buffer),
      imageBuffer: expect.any(Buffer),
      videoExt: "mp4",
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining("sophie"),
      expect.any(Buffer),
      expect.objectContaining({
        access: "public",
        contentType: "video/mp4",
        token: "vercel_blob_token_123",
      }),
    );
  });

  it("detects video extension from URL", async () => {
    const app = buildApp();
    await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send({ ...validBody, videoUrl: "https://example.com/recording.webm" })
      .expect(200);

    expect(composeSplitScreen).toHaveBeenCalledWith(
      expect.objectContaining({ videoExt: "webm" }),
    );
  });

  it("returns 500 when composition throws", async () => {
    vi.mocked(composeSplitScreen).mockRejectedValueOnce(new Error("ffmpeg crashed"));

    const app = buildApp();
    const res = await request(app)
      .post("/compose")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(500);

    expect(res.body.error).toBe("Composition failed");
  });

  it("requires API key", async () => {
    const app = buildApp();
    await request(app)
      .post("/compose")
      .send(validBody)
      .expect(401);
  });
});
