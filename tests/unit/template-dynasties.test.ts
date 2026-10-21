import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";

const q = vi.hoisted(() => ({
  listDynasties: vi.fn(),
  getDynasty: vi.fn(),
  resolveDynastyHead: vi.fn(),
  addDynastyVersion: vi.fn(),
  createDynasty: vi.fn(),
}));
vi.mock("../../src/lib/template-dynasty-query.js", () => q);

const { default: routes } = await import("../../src/routes/template-dynasties.js");
const { assertVersionVariables, headOf, templateTwin, dynastyNotFound, TemplateDynastyError } = await import(
  "../../src/lib/template-dynasties.js"
);

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
      caller: { mode: "platform" },
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
