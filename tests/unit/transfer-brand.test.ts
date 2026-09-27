import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockTransfer = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/transfer-brand.js", () => ({
  transferBrand: mockTransfer,
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

  it("passes the parsed body to transferBrand and returns its report", async () => {
    const report = { updatedTables: [{ tableName: "email_generations", count: 5 }] };
    mockTransfer.mockResolvedValueOnce(report);
    const app = buildApp();
    const body = { sourceBrandId: SOURCE_BRAND, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG, targetBrandId: TARGET_BRAND };
    const res = await request(app).post("/internal/transfer-brand").send(body).expect(200);

    expect(res.body).toEqual(report);
    expect(mockTransfer).toHaveBeenCalledWith(body);
  });

  it("does not call transferBrand on an invalid body", async () => {
    const app = buildApp();
    await request(app).post("/internal/transfer-brand").send({ sourceOrgId: SOURCE_ORG }).expect(400);
    expect(mockTransfer).not.toHaveBeenCalled();
  });
});
