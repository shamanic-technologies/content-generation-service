import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockExecute = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/index.js", () => ({
  db: { execute: mockExecute },
}));

const { default: transferBrandRoutes } = await import("../../src/routes/transfer-brand.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(transferBrandRoutes);
  return app;
}

describe("POST /internal/transfer-brand", () => {
  const SOURCE_BRAND = "a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1";
  const TARGET_BRAND = "d4d4d4d4-d4d4-4d4d-84d4-d4d4d4d4d4d4";
  const SOURCE_ORG = "b2b2b2b2-b2b2-4b2b-b2b2-b2b2b2b2b2b2";
  const TARGET_ORG = "c3c3c3c3-c3c3-4c3c-83c3-c3c3c3c3c3c3";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 if sourceBrandId is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 if sourceBrandId is not a valid UUID", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: "not-a-uuid", sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 if sourceOrgId is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: SOURCE_BRAND, targetOrgId: TARGET_ORG })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 if targetOrgId is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: SOURCE_BRAND, sourceOrgId: SOURCE_ORG })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 if targetBrandId is not a valid UUID", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: SOURCE_BRAND, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG, targetBrandId: "not-a-uuid" })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns updated count when rows are transferred (no targetBrandId)", async () => {
    mockExecute.mockResolvedValueOnce([{ "1": 1 }, { "1": 1 }, { "1": 1 }, { "1": 1 }, { "1": 1 }]);
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: SOURCE_BRAND, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG })
      .expect(200);

    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_generations", count: 5 }],
    });
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it("returns combined count when rows are transferred with targetBrandId (conflict rewrite)", async () => {
    // Step 1: org reassignment returns 3 rows
    mockExecute.mockResolvedValueOnce([{ "1": 1 }, { "1": 1 }, { "1": 1 }]);
    // Step 2: brand rewrite returns 3 rows
    mockExecute.mockResolvedValueOnce([{ "1": 1 }, { "1": 1 }, { "1": 1 }]);
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: SOURCE_BRAND, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG, targetBrandId: TARGET_BRAND })
      .expect(200);

    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_generations", count: 6 }],
    });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("returns count 0 when no rows match (idempotent re-run)", async () => {
    mockExecute.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: SOURCE_BRAND, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG })
      .expect(200);

    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_generations", count: 0 }],
    });
  });
});
