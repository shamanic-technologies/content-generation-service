import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { requestLog } from "../../src/middleware/request-log.js";

/**
 * A fatal OOM gives no chance to log on the way out, so the request that killed
 * the process has to be named when it STARTS — the last `[req] ->` line before
 * the fatal is the culprit. These pin that line's existence and its contents.
 */

let logs: string[];
let spy: ReturnType<typeof vi.spyOn>;

function buildApp() {
  const app = express();
  app.use(requestLog);
  app.use(express.json());
  app.post("/echo", (req, res) => res.json({ ok: true, seen: Object.keys(req.body).length }));
  return app;
}

beforeEach(() => {
  logs = [];
  spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
    logs.push(String(msg));
  });
});

afterEach(() => {
  spy.mockRestore();
});

describe("requestLog", () => {
  it("names the route and the inbound size before the handler runs", async () => {
    const app = express();
    app.use(requestLog);
    app.use(express.json());
    app.post("/generate", (_req, res) => {
      // Whatever happens next (including a fatal), the start line is already out.
      expect(logs.some((l) => l.startsWith("[req] -> POST /generate"))).toBe(true);
      res.json({ ok: true });
    });

    await request(app).post("/generate").send({ a: "b" }).expect(200);

    const start = logs.find((l) => l.startsWith("[req] ->"))!;
    expect(start).toContain("POST /generate");
    expect(start).toMatch(/inBytes=\d+/);
    expect(start).not.toMatch(/inBytes=0\b/);
  });

  it("logs identity and attribution headers, never the body", async () => {
    const app = buildApp();

    await request(app)
      .post("/echo")
      .set("x-org-id", "org-abc")
      .set("x-run-id", "run-xyz")
      .send({ secret: "customer content that must never be logged" })
      .expect(200);

    const joined = logs.join("\n");
    expect(joined).toContain("org=org-abc");
    expect(joined).toContain("run=run-xyz");
    expect(joined).not.toContain("customer content");
    expect(joined).not.toContain("secret");
  });

  it("logs status, duration and outbound size on completion", async () => {
    const app = buildApp();

    await request(app).post("/echo").send({ a: 1 }).expect(200);

    const done = logs.find((l) => l.startsWith("[req] <-"))!;
    expect(done).toContain("POST /echo 200");
    expect(done).toMatch(/ms=\d+/);
    expect(done).toMatch(/outBytes=\d+/);
    expect(done).not.toMatch(/outBytes=0\b/);
  });

  it("falls back to placeholders when identity headers are absent", async () => {
    const app = buildApp();

    await request(app).post("/echo").send({ a: 1 }).expect(200);

    expect(logs.find((l) => l.startsWith("[req] ->"))).toContain("org=- run=-");
  });
});
