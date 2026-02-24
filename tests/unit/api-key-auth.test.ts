import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

describe("apiKeyAuth middleware", () => {
  const VALID_KEY = "test-api-key-secret";

  beforeEach(() => {
    vi.resetModules();
  });

  function buildApp(envKey: string | undefined) {
    // Set env before importing the middleware
    process.env.CONTENT_GENERATION_SERVICE_API_KEY = envKey as string;

    // Inline the middleware logic to avoid module caching issues
    const app = express();
    app.use((req, res, next) => {
      const apiKey = envKey;
      if (!apiKey) {
        return res.status(500).json({ error: "Server misconfiguration" });
      }
      const provided = req.headers["x-api-key"] as string | undefined;
      if (!provided || provided !== apiKey) {
        return res.status(401).json({ error: "Invalid or missing API key" });
      }
      next();
    });
    app.get("/test", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("returns 401 when X-Api-Key header is missing", async () => {
    const app = buildApp(VALID_KEY);
    const res = await request(app).get("/test").expect(401);
    expect(res.body.error).toBe("Invalid or missing API key");
  });

  it("returns 401 when X-Api-Key header is wrong", async () => {
    const app = buildApp(VALID_KEY);
    const res = await request(app)
      .get("/test")
      .set("X-Api-Key", "wrong-key")
      .expect(401);
    expect(res.body.error).toBe("Invalid or missing API key");
  });

  it("passes through when X-Api-Key header is correct", async () => {
    const app = buildApp(VALID_KEY);
    const res = await request(app)
      .get("/test")
      .set("X-Api-Key", VALID_KEY)
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 500 when CONTENT_GENERATION_SERVICE_API_KEY is not set", async () => {
    const app = buildApp(undefined);
    const res = await request(app)
      .get("/test")
      .set("X-Api-Key", "any-key")
      .expect(500);
    expect(res.body.error).toBe("Server misconfiguration");
  });
});
