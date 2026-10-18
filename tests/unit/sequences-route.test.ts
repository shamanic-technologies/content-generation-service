import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockRead = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/sequence-feed-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/sequence-feed-query.js")>();
  return { ...actual, readSequenceFeed: mockRead };
});

const { default: sequenceRoutes } = await import("../../src/routes/sequences.js");
const { encodeCursor, decodeCursor } = await import("../../src/lib/sequence-feed-query.js");

function buildApp() {
  const app = express();
  app.use(sequenceRoutes);
  return app;
}

const ID = "a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1";

describe("GET /internal/sequences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRead.mockResolvedValue({ sequences: [], nextCursor: null, hasMore: false });
  });

  it("400s without featureSlug", async () => {
    await request(buildApp()).get("/internal/sequences").expect(400);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("400s on a limit over the max", async () => {
    await request(buildApp()).get("/internal/sequences?featureSlug=x&limit=5000").expect(400);
  });

  it("400s on a cursor it did not issue", async () => {
    const res = await request(buildApp()).get("/internal/sequences?featureSlug=x&cursor=garbage").expect(400);
    expect(res.body.error).toMatch(/cursor/);
  });

  it("reads from the start with the default page size and the 60 s settle window", async () => {
    await request(buildApp()).get("/internal/sequences?featureSlug=sales-cold-email-outreach").expect(200);
    expect(mockRead).toHaveBeenCalledWith({
      featureSlug: "sales-cold-email-outreach",
      cursor: null,
      limit: 500,
      settleSeconds: 60,
    });
  });

  it("resumes from a cursor it issued", async () => {
    const cursor = encodeCursor({ createdAt: "2026-10-18 09:00:00.123456+00", id: ID });
    await request(buildApp())
      .get(`/internal/sequences?featureSlug=x&limit=10&cursor=${cursor}`)
      .expect(200);
    expect(mockRead).toHaveBeenCalledWith({
      featureSlug: "x",
      cursor: { createdAt: "2026-10-18 09:00:00.123456+00", id: ID },
      limit: 10,
      settleSeconds: 60,
    });
  });
});

describe("cursor codec", () => {
  it("round-trips microsecond timestamps", () => {
    const c = { createdAt: "2026-03-24 12:40:28.963991+00", id: ID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("rejects a non-uuid id", () => {
    expect(decodeCursor(Buffer.from("2026-03-24 12:40:28+00|nope").toString("base64url"))).toBeNull();
  });
});
