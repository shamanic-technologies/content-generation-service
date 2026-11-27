import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { CheckedHop, Resolver, Transport } from "../../src/lib/safe-fetch.js";

// SSRF-1127: POST /compose downloads the CALLER's videoUrl (gateway, any user key, MCP).
// The real publicFetch runs; only DNS and the socket are faked, so every hop the route
// would dial is recorded and none may be a non-public address.

const dialled: CheckedHop[] = [];

/** DNS as the attacker's names answer it: nip.io embeds its IP, the rest is public. */
const fakeDns: Resolver = async (host) => {
  const embedded = host.match(/^(\d+\.\d+\.\d+\.\d+)\.nip\.io$/);
  if (embedded) return [{ address: embedded[1], family: 4 }];
  return [{ address: "104.18.1.1", family: 4 }];
};

const transport: Transport = async (hop) => {
  dialled.push(hop);
  if (hop.url.hostname === "redirector.example.com") {
    return new Response(null, { status: 302, headers: { location: hop.url.searchParams.get("to")! } });
  }
  return new Response(new Uint8Array(64), { status: 200, headers: { "content-type": "video/mp4" } });
};

vi.mock("../../src/lib/safe-fetch.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/safe-fetch.js")>();
  return {
    ...real,
    publicFetch: (url: string, init: Parameters<typeof real.publicFetch>[1] = {}) =>
      real.publicFetch(url, { ...init, resolve: fakeDns, transport }),
  };
});
vi.mock("../../src/lib/quote-image.js", () => ({ generateQuoteImage: vi.fn().mockResolvedValue(Buffer.from("png")) }));
vi.mock("../../src/lib/ffmpeg-compose.js", () => ({ composeSplitScreen: vi.fn().mockResolvedValue(Buffer.from("mp4")) }));
vi.mock("@vercel/blob", () => ({ put: vi.fn().mockResolvedValue({ url: "https://blob.vercel-storage.com/composed/x.mp4" }) }));

import composeRoutes from "../../src/routes/compose.js";
import { isPublicAddress } from "../../src/lib/safe-fetch.js";
import { composeSplitScreen } from "../../src/lib/ffmpeg-compose.js";

const app = express();
app.use(express.json());
app.use(composeRoutes);

const body = (videoUrl: string) => ({ videoUrl, name: "Test", age: 30, theme: "t", text: "t", outputBlobToken: "tok" });

describe("POST /compose refuses every non-public videoUrl (SSRF-1127)", () => {
  beforeEach(() => {
    dialled.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    "https://127.0.0.1/v.mp4",
    "https://localhost/v.mp4",
    "https://key-service:8080/internal/keys",
    "https://windmill-server:8000/api",
    "https://10.0.0.5/v.mp4",
    "https://172.17.0.1/v.mp4",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/v.mp4",
    "https://[::ffff:7f00:1]/v.mp4",
    "https://127.0.0.1.nip.io:2019/config/",
    "https://172.17.0.1.nip.io:2019/config/",
    "https://169.254.169.254.nip.io/latest/meta-data/",
    "https://62.83.93.230/",
    "http://cdn.example.com/v.mp4", // http: refused, https only
    "https://redirector.example.com/r?to=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F",
    "https://redirector.example.com/r?to=https%3A%2F%2Fkey-service%3A8080%2F",
    "https://redirector.example.com/r?to=https%3A%2F%2F127.0.0.1.nip.io%2F",
  ])("%s -> 400 VIDEO_URL_NOT_PUBLIC, nothing private dialled", async (url) => {
    const res = await request(app).post("/compose").send(body(url)).expect(400);

    expect(res.body.code).toBe("VIDEO_URL_NOT_PUBLIC");
    expect(dialled.every((h) => isPublicAddress(h.address))).toBe(true);
    expect(dialled.every((h) => h.url.hostname === "redirector.example.com")).toBe(true);
    expect(composeSplitScreen).not.toHaveBeenCalled();
  });

  it("a public https URL still composes", async () => {
    const res = await request(app).post("/compose").send(body("https://cdn.example.com/v.mp4")).expect(200);

    expect(res.body.composedVideoUrl).toBe("https://blob.vercel-storage.com/composed/x.mp4");
    expect(dialled.map((h) => h.url.href)).toEqual(["https://cdn.example.com/v.mp4"]);
    expect(composeSplitScreen).toHaveBeenCalledTimes(1);
  });

  it("a public redirect to another public https URL still composes", async () => {
    await request(app)
      .post("/compose")
      .send(body("https://redirector.example.com/r?to=https%3A%2F%2Fcdn.example.com%2Fv.mp4"))
      .expect(200);

    expect(dialled.map((h) => h.url.hostname)).toEqual(["redirector.example.com", "cdn.example.com"]);
  });
});
