import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { mountJsonBodyParsers, respondIfBodyTooLarge } from "../../src/lib/json-body.js";

// EMAIL-413-1030: a script-writer /generate body for a brand with a long context
// (Doc Dinners, 2026-10-29) weighed ~148 KB: written 88.6 KB, units 32.6 KB,
// variables 26 KB. Every run 413'd on the 100kb default.
function buildApp() {
  const app = express();
  mountJsonBodyParsers(app);
  const echo = (req: express.Request, res: express.Response) =>
    res.json({ bytes: JSON.stringify(req.body).length, keys: Object.keys(req.body) });
  app.post("/generate", echo);
  app.post("/generate/materials", echo);
  app.post("/generate-whatsapp", echo);
  app.post("/prompts", echo);
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (respondIfBodyTooLarge(err, req, res)) return;
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

const pad = (kb: number) => "x".repeat(kb * 1024);

function scriptWriterBody() {
  return {
    type: "blind-discovery-email-v21-no-url-spaced",
    leadId: "04d82025-0c68-412d-a69e-26ca30c329c4",
    variables: { brandDescription: pad(26) },
    units: { brand_context: { content: { variables: { about: pad(32) } } } },
    written: { output: { subject: "s", sequence: [{ bodyHtml: pad(88) }] } },
  };
}

describe("inbound JSON ceilings", () => {
  it("POST /generate accepts a ~150 KB script-writer body whole", async () => {
    const body = scriptWriterBody();
    const sent = JSON.stringify(body).length;
    expect(sent).toBeGreaterThan(145 * 1024);
    const res = await request(buildApp()).post("/generate").send(body);
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBe(sent);
    expect(res.body.keys).toEqual(["type", "leadId", "variables", "units", "written"]);
  });

  it("POST /generate/materials accepts the same size", async () => {
    const res = await request(buildApp()).post("/generate/materials").send(scriptWriterBody());
    expect(res.status).toBe(200);
  });

  it("the writer doors stay bounded: over 1mb is a readable 413", async () => {
    const res = await request(buildApp()).post("/generate").send({ written: { x: pad(1100) } });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body exceeds the 1mb limit", limit: "1mb" });
  });

  it("every other route keeps the 100kb default", async () => {
    for (const path of ["/prompts", "/generate-whatsapp"]) {
      const res = await request(buildApp()).post(path).send(scriptWriterBody());
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: "Request body exceeds the 100kb limit", limit: "100kb" });
    }
    const small = await request(buildApp()).post("/prompts").send({ a: pad(50) });
    expect(small.status).toBe(200);
  });
});
