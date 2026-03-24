import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  createProject,
  pollProjectCompletion,
  triggerExport,
  pollExportUrl,
} from "../../src/lib/submagic-client.js";

const FAKE_KEY = "sk-submagic-test";

describe("submagic-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBMAGIC_API_KEY = FAKE_KEY;
  });

  afterEach(() => {
    delete process.env.SUBMAGIC_API_KEY;
  });

  describe("createProject", () => {
    it("sends correct request and returns project id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "proj-abc" }),
      });

      const result = await createProject({
        composedVideoUrl: "https://example.com/video.mp4",
        title: "Test Project",
        templateName: "Hormozi 2",
        language: "en",
        magicZooms: true,
        magicBrolls: false,
        magicBrollsPercentage: 0,
        removeBadTakes: true,
        removeSilencePace: "fast",
        cleanAudio: true,
      });

      expect(result).toEqual({ id: "proj-abc" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.submagic.co/v1/projects",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-api-key": FAKE_KEY,
          }),
        }),
      );
    });

    it("throws when API returns error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Invalid video format"),
      });

      await expect(
        createProject({
          composedVideoUrl: "https://example.com/video.mp4",
          title: "Test",
          templateName: "T",
          language: "en",
          magicZooms: false,
          magicBrolls: false,
          magicBrollsPercentage: 0,
          removeBadTakes: false,
          removeSilencePace: "fast",
          cleanAudio: false,
        }),
      ).rejects.toThrow("Submagic create project failed (422)");
    });

    it("throws when SUBMAGIC_API_KEY is not set", async () => {
      delete process.env.SUBMAGIC_API_KEY;

      await expect(
        createProject({
          composedVideoUrl: "https://example.com/video.mp4",
          title: "Test",
          templateName: "T",
          language: "en",
          magicZooms: false,
          magicBrolls: false,
          magicBrollsPercentage: 0,
          removeBadTakes: false,
          removeSilencePace: "fast",
          cleanAudio: false,
        }),
      ).rejects.toThrow("SUBMAGIC_API_KEY is not set");
    });
  });

  describe("pollProjectCompletion", () => {
    it("returns immediately when project is already completed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "proj-1", status: "completed" }),
      });

      const result = await pollProjectCompletion("proj-1", 10, 1000);
      expect(result.status).toBe("completed");
    });

    it("polls until completed", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "proj-1", status: "processing" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "proj-1", status: "completed" }),
        });

      const result = await pollProjectCompletion("proj-1", 10, 5000);
      expect(result.status).toBe("completed");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws when project status is failed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "proj-1", status: "failed" }),
      });

      await expect(pollProjectCompletion("proj-1", 10, 1000)).rejects.toThrow(
        "Submagic project failed with status: failed",
      );
    });

    it("throws on timeout", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "proj-1", status: "processing" }),
      });

      await expect(pollProjectCompletion("proj-1", 10, 30)).rejects.toThrow(
        "timed out",
      );
    });
  });

  describe("triggerExport", () => {
    it("sends export request", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await triggerExport("proj-1", { width: 1080, height: 1920, fps: 30 });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.submagic.co/v1/projects/proj-1/export",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws on error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        triggerExport("proj-1", { width: 1080, height: 1920, fps: 30 }),
      ).rejects.toThrow("Submagic export trigger failed (500)");
    });
  });

  describe("pollExportUrl", () => {
    it("returns when directUrl is available", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "proj-1",
            status: "completed",
            directUrl: "https://r2.submagic.pro/video.mp4",
          }),
      });

      const result = await pollExportUrl("proj-1", 10, 1000);
      expect(result.videoUrl).toBe("https://r2.submagic.pro/video.mp4");
    });

    it("returns when downloadUrl is available (fallback)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "proj-1",
            status: "completed",
            downloadUrl: "https://r2.submagic.pro/download.mp4",
          }),
      });

      const result = await pollExportUrl("proj-1", 10, 1000);
      expect(result.videoUrl).toBe("https://r2.submagic.pro/download.mp4");
    });

    it("polls until URL appears", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "proj-1", status: "exporting" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "proj-1",
              status: "completed",
              directUrl: "https://r2.submagic.pro/video.mp4",
            }),
        });

      const result = await pollExportUrl("proj-1", 10, 5000);
      expect(result.videoUrl).toBe("https://r2.submagic.pro/video.mp4");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
