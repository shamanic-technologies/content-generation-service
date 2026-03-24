import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the submagic client
vi.mock("../../src/lib/submagic-client.js", () => ({
  createProject: vi.fn().mockResolvedValue({ id: "proj-123" }),
  pollProjectCompletion: vi.fn().mockResolvedValue({ id: "proj-123", status: "completed" }),
  triggerExport: vi.fn().mockResolvedValue(undefined),
  pollExportUrl: vi.fn().mockResolvedValue({ videoUrl: "https://r2.submagic.pro/api/video.mp4" }),
}));

import submagicRoutes from "../../src/routes/submagic.js";
import {
  createProject,
  pollProjectCompletion,
  triggerExport,
  pollExportUrl,
} from "../../src/lib/submagic-client.js";

const VALID_KEY = "test-key";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const key = req.headers["x-api-key"];
    if (key !== VALID_KEY) return res.status(401).json({ error: "Unauthorized" });
    next();
  });
  app.use(submagicRoutes);
  return app;
}

const validBody = {
  composedVideoUrl: "https://blob.vercel-storage.com/composed/xxx.mp4",
  title: "Sophie - Loss of Desire - 2026-03-24",
  templateName: "Hormozi 2",
  language: "en",
  magicZooms: true,
  magicBrolls: true,
  magicBrollsPercentage: 30,
  removeBadTakes: true,
  removeSilencePace: "fast",
  cleanAudio: true,
  exportWidth: 1080,
  exportHeight: 1920,
  exportFps: 30,
};

describe("POST /submagic/process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when required fields are missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send({ composedVideoUrl: "https://example.com/video.mp4" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when composedVideoUrl is not a valid URL", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send({ ...validBody, composedVideoUrl: "not-a-url" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when magicBrollsPercentage is out of range", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send({ ...validBody, magicBrollsPercentage: 150 })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when exportWidth is not positive", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send({ ...validBody, exportWidth: 0 })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("processes video and returns result on success", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(200);

    expect(res.body).toEqual({
      projectId: "proj-123",
      videoUrl: "https://r2.submagic.pro/api/video.mp4",
      previewUrl: "https://app.submagic.co/view/proj-123",
    });

    expect(createProject).toHaveBeenCalledWith({
      composedVideoUrl: validBody.composedVideoUrl,
      title: validBody.title,
      templateName: validBody.templateName,
      language: validBody.language,
      magicZooms: true,
      magicBrolls: true,
      magicBrollsPercentage: 30,
      removeBadTakes: true,
      removeSilencePace: "fast",
      cleanAudio: true,
    });

    expect(pollProjectCompletion).toHaveBeenCalledWith("proj-123");

    expect(triggerExport).toHaveBeenCalledWith("proj-123", {
      width: 1080,
      height: 1920,
      fps: 30,
    });

    expect(pollExportUrl).toHaveBeenCalledWith("proj-123");
  });

  it("returns 502 when createProject fails", async () => {
    vi.mocked(createProject).mockRejectedValueOnce(new Error("API down"));

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(502);

    expect(res.body).toEqual({
      error: "Submagic processing failed",
      reason: "API down",
    });
  });

  it("returns 502 when pollProjectCompletion times out", async () => {
    vi.mocked(pollProjectCompletion).mockRejectedValueOnce(
      new Error("Submagic project completion timed out after 5 minutes"),
    );

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(502);

    expect(res.body.error).toBe("Submagic processing failed");
    expect(res.body.reason).toMatch(/timed out/);
  });

  it("returns 502 when triggerExport fails", async () => {
    vi.mocked(triggerExport).mockRejectedValueOnce(new Error("Export not supported"));

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(502);

    expect(res.body.error).toBe("Submagic processing failed");
    expect(res.body.reason).toBe("Export not supported");
  });

  it("returns 502 when pollExportUrl times out", async () => {
    vi.mocked(pollExportUrl).mockRejectedValueOnce(
      new Error("Submagic export URL timed out after 3 minutes"),
    );

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .send(validBody)
      .expect(502);

    expect(res.body.error).toBe("Submagic processing failed");
    expect(res.body.reason).toMatch(/timed out/);
  });

  it("requires API key", async () => {
    const app = buildApp();
    await request(app)
      .post("/submagic/process")
      .send(validBody)
      .expect(401);
  });
});
