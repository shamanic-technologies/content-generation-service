import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { TEMPLATE_DYNASTY_CREATE_SUPPORT, TEMPLATE_DYNASTY_VERSION_SUPPORT } from "../../src/lib/platform-judgment-support.js";

const q = vi.hoisted(() => ({
  listDynasties: vi.fn(),
  getDynasty: vi.fn(),
  resolveDynastyHead: vi.fn(),
  addDynastyVersion: vi.fn(),
  createDynasty: vi.fn(),
  readDynastyOutputs: vi.fn(),
  mergeDynasty: vi.fn(),
}));
vi.mock("../../src/lib/template-dynasty-query.js", () => q);

const { default: routes } = await import("../../src/routes/template-dynasties.js");
const { assertMergeable, assertVersionVariables, assertVariablesMatchText, headOf, templateTwin, dynastyNotFound, TemplateDynastyError } = await import(
  "../../src/lib/template-dynasties.js"
);
const { TemplateNotNeutralError } = await import("../../src/lib/template-neutrality.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use(routes);
  return a;
}

const DYNASTY = {
  slug: "cold-reply-intro-offer-blind",
  name: "Blind Intro Offer",
  description: "d",
  signature: "s",
  identity: "blind",
  featureSlug: "sales-cold-email-outreach",
  legKey: "lead_found_to_conversation",
  head: "blind-discovery-email-v2",
  versions: [
    { type: "blind-discovery-email", position: 1, status: "active", addedAt: "t" },
    { type: "blind-discovery-email-v2", position: 2, status: "active", addedAt: "t" },
  ],
  createdAt: "t",
  updatedAt: "t",
};
const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: null,
  type: "blind-discovery-email-v3",
  prompt: "Hi {{leadFirstName}}",
  variables: [{ name: "leadFirstName", description: "first name" }],
  status: "active",
  statusChangedAt: null,
  statusReason: null,
  statusChangedBy: null,
  createdAt: new Date("2026-10-21T00:00:00Z"),
  updatedAt: new Date("2026-10-21T00:00:00Z"),
};

describe("template dynasty rules", () => {
  const head = { type: "cold-email-v68", variables: [{ name: "a", description: "" }, { name: "b", description: "" }] };

  it("a version may use the head's tokens or fewer, never a new one", () => {
    expect(() => assertVersionVariables("{{a}} {{b}}", head.variables, head)).not.toThrow();
    expect(() => assertVersionVariables("{{a}}", [{ name: "a", description: "" }], head)).not.toThrow();
    try {
      assertVersionVariables("{{a}} {{c}}", [{ name: "a", description: "" }, { name: "c", description: "" }], head);
      expect.unreachable();
    } catch (e) {
      expect((e as InstanceType<typeof TemplateDynastyError>).code).toBe("VARIABLE_NOT_IN_HEAD");
      expect((e as Error).message).toContain("{{c}}");
    }
  });

  it("declared variables must be exactly the tokens the text uses", () => {
    expect(() => assertVersionVariables("{{a}}", head.variables, head)).toThrow(/unused: b/);
    expect(() => assertVersionVariables("{{a}} {{b}}", [{ name: "a", description: "" }], head)).toThrow(/undeclared: b/);
  });

  it("a new dynasty's text: variables exactly its tokens, no head involved", () => {
    expect(() => assertVariablesMatchText("{{x}} {{y}}", [{ name: "x", description: "" }, { name: "y", description: "" }])).not.toThrow();
    expect(() => assertVariablesMatchText("{{x}}", [])).toThrow(/undeclared: x/);
    expect(() => assertVariablesMatchText("plain", [{ name: "x", description: "" }])).toThrow(/unused: x/);
  });

  it("the head is the highest position, whatever the order", () => {
    expect(headOf([{ type: "x-v3", position: 3 }, { type: "x", position: 1 }, { type: "x-v2", position: 2 }])).toBe("x-v3");
    expect(headOf([])).toBeNull();
  });
});

describe("template dynasty routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists, filtered by pipe", async () => {
    q.listDynasties.mockResolvedValue([DYNASTY]);
    const res = await request(app())
      .get("/internal/template-dynasties?featureSlug=sales-cold-email-outreach&legKey=lead_found_to_conversation")
      .expect(200);
    expect(q.listDynasties).toHaveBeenCalledWith({ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" });
    expect(res.body.dynasties[0].head).toBe("blind-discovery-email-v2");
  });

  it("reads one, 404 named when unknown", async () => {
    q.getDynasty.mockResolvedValueOnce(DYNASTY);
    await request(app()).get(`/internal/template-dynasties/${DYNASTY.slug}`).expect(200);
    q.getDynasty.mockRejectedValueOnce(dynastyNotFound("nope"));
    const res = await request(app()).get("/internal/template-dynasties/nope").expect(404);
    expect(res.body.code).toBe("DYNASTY_NOT_FOUND");
  });

  it("resolves the head as a full stored template", async () => {
    q.resolveDynastyHead.mockResolvedValue({ dynasty: DYNASTY, template: { ...ROW, type: "blind-discovery-email-v2" } });
    const res = await request(app()).get(`/internal/template-dynasties/${DYNASTY.slug}/head`).expect(200);
    expect(res.body.template.type).toBe("blind-discovery-email-v2");
    expect(res.body.template.contextVariables.length).toBeGreaterThan(0);
    expect(res.body.dynasty.slug).toBe(DYNASTY.slug);
  });

  it("adds a version (platform-billed judgment) and answers the new head", async () => {
    q.addDynastyVersion.mockResolvedValue({ dynasty: { ...DYNASTY, head: ROW.type }, template: ROW });
    const res = await request(app())
      .post(`/internal/template-dynasties/${DYNASTY.slug}/versions`)
      .set("x-org-id", "22222222-2222-2222-2222-222222222222")
      .send({ prompt: ROW.prompt, variables: ROW.variables })
      .expect(201);
    expect(q.addDynastyVersion).toHaveBeenCalledWith({
      slug: DYNASTY.slug,
      version: { prompt: ROW.prompt, variables: ROW.variables },
      orgId: "22222222-2222-2222-2222-222222222222",
      caller: { mode: "platform", support: TEMPLATE_DYNASTY_VERSION_SUPPORT },
      changedBy: "template-dynasty-upgrade",
    });
    expect(res.body.dynasty.head).toBe(ROW.type);
    expect(res.body.template.type).toBe(ROW.type);
  });

  it("records the staff email as who deprecated the previous head", async () => {
    q.addDynastyVersion.mockResolvedValue({ dynasty: { ...DYNASTY, head: ROW.type }, template: ROW });
    await request(app())
      .post(`/internal/template-dynasties/${DYNASTY.slug}/versions`)
      .set("x-staff-email", " Kevin@Distribute.you ")
      .send({ prompt: ROW.prompt, variables: ROW.variables })
      .expect(201);
    expect(q.addDynastyVersion).toHaveBeenCalledWith(expect.objectContaining({ changedBy: "kevin@distribute.you" }));
  });

  it("appends an already-stored template by type; refuses a body mixing both forms", async () => {
    q.addDynastyVersion.mockResolvedValue({ dynasty: { ...DYNASTY, head: ROW.type }, template: ROW });
    await request(app())
      .post(`/internal/template-dynasties/${DYNASTY.slug}/versions`)
      .send({ type: "blind-discovery-email-v47-spaced" })
      .expect(201);
    expect(q.addDynastyVersion).toHaveBeenLastCalledWith(expect.objectContaining({ version: { type: "blind-discovery-email-v47-spaced" } }));
    await request(app())
      .post(`/internal/template-dynasties/${DYNASTY.slug}/versions`)
      .send({ type: "x", prompt: "y", variables: [] })
      .expect(400);
    expect(q.addDynastyVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses an identical text with the twin named", async () => {
    q.addDynastyVersion.mockRejectedValue(templateTwin("blind-discovery-email-v40"));
    const res = await request(app())
      .post(`/internal/template-dynasties/${DYNASTY.slug}/versions`)
      .send({ prompt: "same", variables: [] })
      .expect(409);
    expect(res.body).toMatchObject({ code: "TEMPLATE_TWIN", twinType: "blind-discovery-email-v40" });
    expect(res.body.error).toContain("blind-discovery-email-v40");
  });

  it("creates a dynasty from a brand-new text (platform-billed judgment); existing-type creation unchanged", async () => {
    q.createDynasty.mockResolvedValue({ ...DYNASTY, head: "eight-second-test-click-v1" });
    const fields = { slug: "eight-second-test-click", name: "8-second test", description: "d2", signature: "s2", identity: "named", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit" };
    const template = { prompt: ROW.prompt, variables: ROW.variables };
    const res = await request(app())
      .post("/internal/template-dynasties")
      .set("x-org-id", "22222222-2222-2222-2222-222222222222")
      .send({ ...fields, template })
      .expect(201);
    expect(q.createDynasty).toHaveBeenLastCalledWith(
      { ...fields, template },
      { orgId: "22222222-2222-2222-2222-222222222222", caller: { mode: "platform", support: TEMPLATE_DYNASTY_CREATE_SUPPORT }, changedBy: "template-dynasty-upgrade" },
    );
    expect(res.body.head).toBe("eight-second-test-click-v1");

    await request(app()).post("/internal/template-dynasties").set("x-staff-email", "Kevin@Distribute.you").send({ ...fields, versions: ["cold-email-v68"] }).expect(201);
    expect(q.createDynasty).toHaveBeenLastCalledWith(
      { ...fields, versions: ["cold-email-v68"] },
      { orgId: null, caller: { mode: "platform", support: TEMPLATE_DYNASTY_CREATE_SUPPORT }, changedBy: "kevin@distribute.you" },
    );

    for (const body of [fields, { ...fields, versions: ["x"], template }, { ...fields, template: { ...template, type: "Bad Type" } }]) {
      const r = await request(app()).post("/internal/template-dynasties").send(body).expect(400);
      expect(r.body.error).toBeTruthy();
    }
    expect(q.createDynasty).toHaveBeenCalledTimes(2);
  });

  it("a refused new text answers its reason: variables mismatch 400, not neutral 422", async () => {
    const fields = { slug: "x-new", name: "n", description: "d", signature: "s", identity: "named", featureSlug: "f", legKey: "l" };
    q.createDynasty.mockRejectedValueOnce(new TemplateDynastyError(400, "VARIABLES_MISMATCH", "variables must list exactly the {{tokens}} the text uses; undeclared: b"));
    const r1 = await request(app()).post("/internal/template-dynasties").send({ ...fields, template: { prompt: "{{b}}", variables: [] } }).expect(400);
    expect(r1.body).toMatchObject({ code: "VARIABLES_MISMATCH" });
    expect(r1.body.error).toContain("undeclared: b");
    q.createDynasty.mockRejectedValueOnce(new TemplateNotNeutralError([{ text: "We saved Acme $2M", location: "line 1", probability: 0.97 }]));
    const r2 = await request(app()).post("/internal/template-dynasties").send({ ...fields, template: { prompt: "We saved Acme $2M", variables: [] } }).expect(422);
    expect(r2.body).toMatchObject({ code: "TEMPLATE_NOT_NEUTRAL" });
    expect(r2.body.passages[0].passage).toBe("We saved Acme $2M");
  });

  it("400s a body without text, before any read", async () => {
    await request(app()).post(`/internal/template-dynasties/${DYNASTY.slug}/versions`).send({ variables: [] }).expect(400);
    await request(app()).post("/internal/template-dynasties").send({ slug: "Bad Slug" }).expect(400);
    expect(q.addDynastyVersion).not.toHaveBeenCalled();
    expect(q.createDynasty).not.toHaveBeenCalled();
  });
});

describe("the seed migration matches the owner-validated dynasties (2026-10-21)", () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "../fixtures/template-dynasties-2026-10-21.json"), "utf8"),
  ) as Array<{ slug: string; name: string; description: string; signature: string; identity: string; feature_slug: string; leg_key: string; versions: string[]; head: string }>;
  const sqlText = readFileSync(join(__dirname, "../../drizzle/0036_template_dynasties.sql"), "utf8");
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

  it("seeds all 26, every field verbatim", () => {
    expect(fixture).toHaveLength(26);
    for (const d of fixture) {
      const tuple = `(${[d.slug, d.name, d.description, d.signature, d.identity, d.feature_slug, d.leg_key].map(lit).join(", ")})`;
      expect(sqlText, d.slug).toContain(tuple);
    }
  });

  it("seeds every version in order, the head last", () => {
    for (const d of fixture) {
      expect(d.versions[d.versions.length - 1]).toBe(d.head);
      d.versions.forEach((type, i) => {
        expect(sqlText, `${d.slug} ${type}`).toContain(`(${lit(d.slug)}, ${lit(type)}, ${i + 1})`);
      });
    }
    const seeded = sqlText.match(/^\s+\('[^']+', '[^']+', \d+\)/gm) ?? [];
    expect(seeded).toHaveLength(fixture.reduce((n, d) => n + d.versions.length, 0));
  });
});

describe("merge a dynasty into another (MERGE-TEMPLATE-DYNASTY-1023)", () => {
  beforeEach(() => vi.clearAllMocks());
  const d = (slug: string, over: Record<string, unknown> = {}) => ({
    slug, featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", identity: "blind", mergedInto: null, ...over,
  });
  const code = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as InstanceType<typeof TemplateDynastyError>).code;
    }
  };

  it("refuses another pipe, another identity, itself, an already-merged dynasty on either side", () => {
    expect(code(() => assertMergeable(d("x"), d("y")))).toBeNull();
    expect(code(() => assertMergeable(d("x"), d("y", { legKey: "lead_found_to_website_visit" })))).toBe("DIFFERENT_PIPE");
    expect(code(() => assertMergeable(d("x"), d("y", { featureSlug: "other" })))).toBe("DIFFERENT_PIPE");
    expect(code(() => assertMergeable(d("x"), d("y", { identity: "named" })))).toBe("DIFFERENT_IDENTITY");
    expect(code(() => assertMergeable(d("x", { identity: "named" }), d("y")))).toBe("DIFFERENT_IDENTITY");
    expect(code(() => assertMergeable(d("x"), d("x")))).toBe("SAME_DYNASTY");
    expect(code(() => assertMergeable(d("x", { mergedInto: "z" }), d("y")))).toBe("DYNASTY_MERGED");
    expect(code(() => assertMergeable(d("x"), d("y", { mergedInto: "z" })))).toBe("DYNASTY_MERGED");
  });

  it("POST /internal/template-dynasties/:slug/merge merges with the staff email and reason", async () => {
    q.mergeDynasty.mockResolvedValue({ merged: "x", movedVersions: ["a"], deprecated: [], dynasty: DYNASTY });
    const res = await request(app())
      .post("/internal/template-dynasties/x/merge")
      .set("x-staff-email", "Kevin@Distribute.you")
      .send({ into: DYNASTY.slug, reason: "  Same approach " });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe("x");
    expect(q.mergeDynasty).toHaveBeenCalledWith({ source: "x", into: DYNASTY.slug, reason: "Same approach", mergedBy: "kevin@distribute.you" });
  });

  it("refuses without x-staff-email, a blank reason or an unknown field, before any write", async () => {
    const noStaff = await request(app()).post("/internal/template-dynasties/x/merge").send({ into: "y", reason: "r" });
    expect(noStaff.status).toBe(400);
    expect(noStaff.body.code).toBe("MERGED_BY_REQUIRED");
    const blank = await request(app()).post("/internal/template-dynasties/x/merge").set("x-staff-email", "k@d.you").send({ into: "y", reason: "  " });
    expect(blank.status).toBe(400);
    const extra = await request(app()).post("/internal/template-dynasties/x/merge").set("x-staff-email", "k@d.you").send({ into: "y", reason: "r", head: "z" });
    expect(extra.status).toBe(400);
    expect(q.mergeDynasty).not.toHaveBeenCalled();
  });

  it("answers a refusal with its status and code", async () => {
    q.mergeDynasty.mockRejectedValue(new TemplateDynastyError(409, "DIFFERENT_IDENTITY", "blind and named"));
    const res = await request(app()).post("/internal/template-dynasties/x/merge").set("x-staff-email", "k@d.you").send({ into: "y", reason: "r" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DIFFERENT_IDENTITY");
  });
});
