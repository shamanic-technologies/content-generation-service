import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * TPL-DYNASTY-ROWS-1021-CG (owner 2026-10-21): in a dynasty only the head may be Active, the
 * dynasty is its head's status, a non-head can never be re-activated, a dynasty version is never
 * forked loose, and a dynasty's last outputs read across its versions.
 */

const dbMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../src/db/index.js", () => ({ db: dbMock, sql: {} }));

const cs = vi.hoisted(() => ({ setTemplateStatus: vi.fn() }));
vi.mock("../../src/lib/catalogue-status-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/catalogue-status-query.js")>();
  return { ...actual, ...cs };
});

const dq = vi.hoisted(() => ({ readDynastyOutputs: vi.fn() }));
vi.mock("../../src/lib/template-dynasty-query.js", () => dq);

const { applyDynastyStatus, UPGRADED_REASON } = await import("../../src/lib/template-dynasties.js");
const membership = await vi.importActual<typeof import("../../src/lib/dynasty-membership.js")>("../../src/lib/dynasty-membership.js");
const { assertNotDynastySource } = membership;
vi.mock("../../src/lib/dynasty-membership.js", async (importOriginal) => importOriginal());
const { default: statusRoutes } = await import("../../src/routes/catalogue-status.js");
const { default: dynastyRoutes } = await import("../../src/routes/template-dynasties.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use(statusRoutes);
  a.use(dynastyRoutes);
  return a;
}

const v = (type: string, position: number, status: "active" | "deprecated", statusReason: string | null = null) => ({
  type, position, addedAt: "t", status, statusReason, statusChangedBy: status === "deprecated" ? "kevin@distribute.you" : null, statusChangedAt: null,
});

describe("applyDynastyStatus", () => {
  it("an older version Active as a template (it heads another pipe's dynasty) reads Deprecated Upgraded here", () => {
    // cold-reply-intro-offer-named in prod: v16 (heads the click pipe's dynasty) at 1, v25 head.
    const { head, versions, status } = applyDynastyStatus([
      v("blind-discovery-email-v16", 1, "active"),
      v("blind-discovery-email-v17", 2, "deprecated", "Upgraded"),
      v("blind-discovery-email-v25", 7, "active"),
    ]);
    expect(head).toBe("blind-discovery-email-v25");
    expect(versions.map((x) => [x.type, x.status, x.statusInDynasty, x.statusReasonInDynasty])).toEqual([
      ["blind-discovery-email-v16", "active", "deprecated", UPGRADED_REASON],
      ["blind-discovery-email-v17", "deprecated", "deprecated", "Upgraded"],
      ["blind-discovery-email-v25", "active", "active", null],
    ]);
    expect(status.status).toBe("active");
    expect(versions.filter((x) => x.statusInDynasty === "active")).toHaveLength(1);
  });

  it("the dynasty is Deprecated exactly when its head is, with the head's reason", () => {
    const { status, versions } = applyDynastyStatus([v("acquisition-questions-email-v1", 1, "deprecated", "Deceptive")]);
    expect(status).toEqual({ status: "deprecated", statusReason: "Deceptive", statusChangedBy: "kevin@distribute.you", statusChangedAt: null });
    expect(versions[0].statusReasonInDynasty).toBe("Deceptive");
  });

  it("a stated reason on an older version is kept, never overwritten by Upgraded", () => {
    const { versions } = applyDynastyStatus([v("a", 1, "deprecated", "Spammy"), v("b", 2, "active")]);
    expect(versions[0].statusReasonInDynasty).toBe("Spammy");
  });
});

describe("staff re-activation of a version", () => {
  beforeEach(() => vi.clearAllMocks());
  const WHO = { "x-staff-email": "kevin@distribute.you" };

  it("is refused with NOT_DYNASTY_HEAD when the template heads none of its dynasties, nothing written", async () => {
    dbMock.execute.mockResolvedValue([{ slug: "cold-reply-observation-named", head: "cold-email-v39-landing-v3-no-url-spaced" }]);
    const res = await request(app()).put("/internal/templates/cold-email-v40/status").set(WHO).send({ status: "active" }).expect(409);
    expect(res.body.code).toBe("NOT_DYNASTY_HEAD");
    expect(res.body.error).toContain("cold-reply-observation-named");
    expect(res.body.error).toContain("cold-email-v39-landing-v3-no-url-spaced");
    expect(cs.setTemplateStatus).not.toHaveBeenCalled();
  });

  it("is allowed for a head (of any of its dynasties) and for a template in no dynasty", async () => {
    cs.setTemplateStatus.mockResolvedValue({ type: "x", status: "active", statusReason: null, statusChangedBy: null, statusChangedAt: null });
    dbMock.execute.mockResolvedValueOnce([{ slug: "a", head: "other" }, { slug: "b", head: "blind-discovery-email-v16" }]);
    await request(app()).put("/internal/templates/blind-discovery-email-v16/status").set(WHO).send({ status: "active" }).expect(200);
    dbMock.execute.mockResolvedValueOnce([]);
    await request(app()).put("/internal/templates/pr-cold-email-v23/status").set(WHO).send({ status: "active" }).expect(200);
    expect(cs.setTemplateStatus).toHaveBeenCalledTimes(2);
  });

  it("a deprecation never reads dynasties (deprecating a head deprecates its dynasty)", async () => {
    cs.setTemplateStatus.mockResolvedValue({ type: "x", status: "deprecated", statusReason: "r", statusChangedBy: "k", statusChangedAt: null });
    await request(app()).put("/internal/templates/cold-email-v69/status").set(WHO).send({ status: "deprecated", reason: "r" }).expect(200);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});

describe("a loose fork of a dynasty version", () => {
  it("is refused with SOURCE_IN_DYNASTY naming the dynasty", async () => {
    dbMock.execute.mockResolvedValueOnce([{ slug: "cold-reply-website-click-named", head: "cold-email-v69" }]);
    await expect(assertNotDynastySource("cold-email-v69")).rejects.toMatchObject({ status: 409, code: "SOURCE_IN_DYNASTY" });
    dbMock.execute.mockResolvedValueOnce([]);
    await expect(assertNotDynastySource("pr-cold-email-v23")).resolves.toBeUndefined();
  });
});

describe("GET /internal/template-dynasties/:slug/outputs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves the dynasty's last outputs across versions, limit passed through", async () => {
    dq.readDynastyOutputs.mockResolvedValue({
      dynasty: { slug: "cold-reply-observation-named" },
      outputs: [
        { generationId: "g2", createdAt: "2026-10-21T10:00:00.000Z", promptType: "cold-email-v39-landing-v3-no-url-spaced", workflowSlug: null, model: "m", subject: "s", emails: [] },
        { generationId: "g1", createdAt: "2026-10-20T10:00:00.000Z", promptType: "cold-email-v40-no-url-spaced", workflowSlug: null, model: "m", subject: "s", emails: [] },
      ],
    });
    const res = await request(app()).get("/internal/template-dynasties/cold-reply-observation-named/outputs?limit=4").expect(200);
    expect(dq.readDynastyOutputs).toHaveBeenCalledWith("cold-reply-observation-named", 4);
    expect(res.body.slug).toBe("cold-reply-observation-named");
    expect(new Set(res.body.outputs.map((o: { promptType: string }) => o.promptType)).size).toBe(2);
  });

  it("defaults to 5 and refuses a bad limit", async () => {
    dq.readDynastyOutputs.mockResolvedValue({ dynasty: { slug: "x" }, outputs: [] });
    await request(app()).get("/internal/template-dynasties/x/outputs").expect(200);
    expect(dq.readDynastyOutputs).toHaveBeenCalledWith("x", 5);
    await request(app()).get("/internal/template-dynasties/x/outputs?limit=0").expect(400);
  });
});
