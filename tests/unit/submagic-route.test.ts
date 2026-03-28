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

// Mock key-client
vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "sk-submagic-resolved", keySource: "platform" }),
}));

// Mock storage-client
vi.mock("../../src/lib/storage-client.js", () => ({
  uploadToStorage: vi.fn().mockResolvedValue({
    id: "file-uuid-001",
    url: "https://storage.mcpfactory.org/videos/proj-123.mp4",
    size: 52428800,
    contentType: "video/mp4",
  }),
}));

import submagicRoutes from "../../src/routes/submagic.js";
import {
  createProject,
  pollProjectCompletion,
  triggerExport,
  pollExportUrl,
} from "../../src/lib/submagic-client.js";
import { decryptKey } from "../../src/lib/key-client.js";
import { uploadToStorage } from "../../src/lib/storage-client.js";

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

const identityHeaders = {
  "X-Api-Key": VALID_KEY,
  "x-org-id": "org-uuid-123",
  "x-user-id": "user-uuid-456",
  "x-run-id": "run-uuid-789",
};

describe("POST /submagic/process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when x-org-id is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .set("x-user-id", "user-uuid-456")
      .set("x-run-id", "run-uuid-789")
      .send(validBody)
      .expect(400);

    expect(res.body.error).toBe("x-org-id header required");
  });

  it("returns 400 when x-user-id is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .set("x-org-id", "org-uuid-123")
      .set("x-run-id", "run-uuid-789")
      .send(validBody)
      .expect(400);

    expect(res.body.error).toBe("x-user-id header required");
  });

  it("returns 400 when x-run-id is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set("X-Api-Key", VALID_KEY)
      .set("x-org-id", "org-uuid-123")
      .set("x-user-id", "user-uuid-456")
      .send(validBody)
      .expect(400);

    expect(res.body.error).toBe("x-run-id header required");
  });

  it("returns 400 when required fields are missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send({ composedVideoUrl: "https://example.com/video.mp4" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when composedVideoUrl is not a valid URL", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send({ ...validBody, composedVideoUrl: "not-a-url" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when magicBrollsPercentage is out of range", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send({ ...validBody, magicBrollsPercentage: 150 })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("resolves key via key-service and processes video on success", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send(validBody)
      .expect(200);

    expect(res.body).toEqual({
      projectId: "proj-123",
      videoUrl: "https://storage.mcpfactory.org/videos/proj-123.mp4",
      previewUrl: "https://app.submagic.co/view/proj-123",
    });

    // Verify key was resolved via key-service
    expect(decryptKey).toHaveBeenCalledWith(
      "submagic",
      "org-uuid-123",
      "user-uuid-456",
      expect.objectContaining({
        callerMethod: "POST",
        callerPath: "/submagic/process",
      }),
    );

    // Verify resolved key was passed to submagic client
    expect(createProject).toHaveBeenCalledWith("sk-submagic-resolved", expect.objectContaining({
      composedVideoUrl: validBody.composedVideoUrl,
      title: validBody.title,
    }));

    expect(pollProjectCompletion).toHaveBeenCalledWith("sk-submagic-resolved", "proj-123");

    expect(triggerExport).toHaveBeenCalledWith("sk-submagic-resolved", "proj-123", {
      width: 1080,
      height: 1920,
      fps: 30,
    });

    expect(pollExportUrl).toHaveBeenCalledWith("sk-submagic-resolved", "proj-123");

    // Verify video was re-uploaded to persistent storage
    expect(uploadToStorage).toHaveBeenCalledWith(
      {
        sourceUrl: "https://r2.submagic.pro/api/video.mp4",
        folder: "videos",
        filename: "proj-123.mp4",
        contentType: "video/mp4",
      },
      expect.objectContaining({
        orgId: "org-uuid-123",
        userId: "user-uuid-456",
        runId: "run-uuid-789",
      }),
    );
  });

  it("returns 502 when key resolution fails", async () => {
    vi.mocked(decryptKey).mockRejectedValueOnce(
      new Error("submagic key not configured for this organization"),
    );

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send(validBody)
      .expect(502);

    expect(res.body).toEqual({
      error: "Submagic processing failed",
      reason: "submagic key not configured for this organization",
    });
  });

  it("returns 502 when createProject fails", async () => {
    vi.mocked(createProject).mockRejectedValueOnce(new Error("API down"));

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send(validBody)
      .expect(502);

    expect(res.body).toEqual({
      error: "Submagic processing failed",
      reason: "API down",
    });
  });

  it("returns 502 when pollProjectCompletion times out", async () => {
    vi.mocked(pollProjectCompletion).mockRejectedValueOnce(
      new Error("Submagic project completion timed out after 1 hour"),
    );

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
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
      .set(identityHeaders)
      .send(validBody)
      .expect(502);

    expect(res.body.error).toBe("Submagic processing failed");
    expect(res.body.reason).toBe("Export not supported");
  });

  it("returns 502 when pollExportUrl times out", async () => {
    vi.mocked(pollExportUrl).mockRejectedValueOnce(
      new Error("Submagic export URL timed out after 1 hour"),
    );

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send(validBody)
      .expect(502);

    expect(res.body.error).toBe("Submagic processing failed");
    expect(res.body.reason).toMatch(/timed out/);
  });

  it("returns 502 when storage upload fails", async () => {
    vi.mocked(uploadToStorage).mockRejectedValueOnce(
      new Error("Storage upload failed (502): R2 unavailable"),
    );

    const app = buildApp();
    const res = await request(app)
      .post("/submagic/process")
      .set(identityHeaders)
      .send(validBody)
      .expect(502);

    expect(res.body.error).toBe("Submagic processing failed");
    expect(res.body.reason).toMatch(/Storage upload failed/);
  });

  it("forwards tracking headers to storage service", async () => {
    const app = buildApp();
    await request(app)
      .post("/submagic/process")
      .set({
        ...identityHeaders,
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1",
        "x-workflow-slug": "case-study",
        "x-feature-slug": "video-captions",
      })
      .send(validBody)
      .expect(200);

    expect(uploadToStorage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        orgId: "org-uuid-123",
        userId: "user-uuid-456",
        runId: "run-uuid-789",
        campaignId: "camp-1",
        brandId: "brand-1",
        workflowSlug: "case-study",
        featureSlug: "video-captions",
      }),
    );
  });

  it("requires API key", async () => {
    const app = buildApp();
    await request(app)
      .post("/submagic/process")
      .send(validBody)
      .expect(401);
  });

  it("forwards optional tracking headers to key-service", async () => {
    const app = buildApp();
    await request(app)
      .post("/submagic/process")
      .set({
        ...identityHeaders,
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1",
        "x-workflow-slug": "case-study",
        "x-feature-slug": "video-captions",
      })
      .send(validBody)
      .expect(200);

    expect(decryptKey).toHaveBeenCalledWith(
      "submagic",
      "org-uuid-123",
      "user-uuid-456",
      expect.objectContaining({
        campaignId: "camp-1",
        brandId: "brand-1",
        workflowSlug: "case-study",
        featureSlug: "video-captions",
      }),
    );
  });
});
