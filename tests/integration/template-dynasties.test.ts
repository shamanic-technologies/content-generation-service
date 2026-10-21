import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { inArray, like, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The brand/offer and blind judgments are chat-service calls (Jev), covered by their own suites.
const guard = vi.hoisted(() => ({
  assertTemplateNeutral: vi.fn(async () => undefined),
  assertBlindTemplateKeepsClientAnonymous: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/template-neutrality-guard.js", () => guard);

const { db } = await import("../../src/db/index.js");
const { prompts, templateDynasties, templateDynastyVersions } = await import("../../src/db/schema.js");
const { addDynastyVersion, createDynasty, deprecateUpgradedVersions, getDynasty, listDynasties, readDynastyOutputs, resolveDynastyHead } = await import(
  "../../src/lib/template-dynasty-query.js"
);
const { assertMayActivate, assertNotDynastySource } = await vi.importActual<typeof import("../../src/lib/dynasty-membership.js")>(
  "../../src/lib/dynasty-membership.js",
);
const { emailGenerations } = await import("../../src/db/schema.js");
const { closeDb, randomId } = await import("../helpers/test-db.js");

const TAG = `tpldyn${randomId().slice(0, 8)}`;
const FAMILY = `${TAG}-email`;
const SLUG = `${TAG}-named`;
const PIPE = { featureSlug: `${TAG}-feature`, legKey: "lead_found_to_conversation" };
const VARS = [{ name: "leadFirstName", description: "first name" }, { name: "brands", description: "brands" }];
const CALLER = { mode: "platform" as const };
const BY = "staff@distribute.you";

const cleanup = async () => {
  await db.delete(emailGenerations).where(like(emailGenerations.promptType, `${TAG}%`));
  await db.delete(templateDynastyVersions).where(like(templateDynastyVersions.dynastySlug, `${TAG}%`));
  await db.delete(templateDynasties).where(like(templateDynasties.slug, `${TAG}%`));
  await db.delete(prompts).where(like(prompts.type, `${TAG}%`));
};

async function seedDynasty(identity: "blind" | "named" = "named", slug = SLUG) {
  await db.insert(prompts).values([
    { type: FAMILY, prompt: `${TAG} v1 {{leadFirstName}} {{brands}}`, variables: VARS },
    { type: `${FAMILY}-v2`, prompt: `${TAG} v2 {{leadFirstName}} {{brands}}`, variables: VARS },
  ]).onConflictDoNothing();
  return createDynasty({
    slug,
    name: `Name ${slug}`,
    description: `Description ${slug}`,
    signature: `Signature ${slug}`,
    identity,
    ...PIPE,
    versions: [FAMILY, `${FAMILY}-v2`],
  });
}

describe("template dynasties", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("the migration seeded the 26 owner-validated dynasties, fields verbatim", async () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/template-dynasties-2026-10-21.json"), "utf8"));
    const rows = await db.select().from(templateDynasties).where(inArray(templateDynasties.slug, fixture.map((d: { slug: string }) => d.slug)));
    expect(rows).toHaveLength(26);
    for (const d of fixture) {
      const row = rows.find((r) => r.slug === d.slug)!;
      expect(row).toMatchObject({
        name: d.name, description: d.description, signature: d.signature, identity: d.identity,
        featureSlug: d.feature_slug, legKey: d.leg_key,
      });
    }
  });

  it("serves a dynasty with its ordered versions and head; lists by pipe", async () => {
    const created = await seedDynasty();
    expect(created.head).toBe(`${FAMILY}-v2`);
    // Creating a dynasty over stored templates leaves only its head Active (TPL-DYNASTY-ROWS-1021-CG).
    expect(created.versions.map((v) => [v.type, v.position, v.status, v.statusInDynasty])).toEqual([
      [FAMILY, 1, "deprecated", "deprecated"],
      [`${FAMILY}-v2`, 2, "active", "active"],
    ]);
    expect(created.status).toBe("active");
    expect((await listDynasties(PIPE)).map((d) => d.slug)).toEqual([SLUG]);
    expect(await listDynasties({ featureSlug: "nope" })).toEqual([]);
    const { template } = await resolveDynastyHead(SLUG);
    expect(template.type).toBe(`${FAMILY}-v2`);
  });

  it("adding a version moves the head, judged on what it adds, the dynasty's identity drives the blind rule", async () => {
    await seedDynasty("blind");
    const text = `${TAG} v3 fixed spacing {{leadFirstName}}`;
    const { dynasty, template } = await addDynastyVersion({
      slug: SLUG, version: { prompt: text, variables: [VARS[0]] }, orgId: null, caller: CALLER, changedBy: BY,
    });
    expect(template.type).toBe(`${FAMILY}-v3`);
    expect(dynasty.head).toBe(`${FAMILY}-v3`);
    expect(dynasty.versions.map((v) => v.position)).toEqual([1, 2, 3]);
    expect((await resolveDynastyHead(SLUG)).template.prompt).toBe(text);
    expect(guard.assertTemplateNeutral).toHaveBeenCalledWith(expect.objectContaining({
      prompt: text, inherited: { prompt: `${TAG} v2 {{leadFirstName}} {{brands}}`, variables: VARS },
    }));
    // The family name is not blind; the dynasty is.
    expect(guard.assertBlindTemplateKeepsClientAnonymous).toHaveBeenCalledWith(expect.objectContaining({ blind: true }));
  });

  it("refuses a text byte-identical to any stored template, naming the twin, nothing stored", async () => {
    await seedDynasty();
    await expect(addDynastyVersion({
      slug: SLUG, version: { prompt: `${TAG} v1 {{leadFirstName}} {{brands}}`, variables: VARS }, orgId: null, caller: CALLER, changedBy: BY,
    })).rejects.toMatchObject({ status: 409, code: "TEMPLATE_TWIN", extra: { twinType: FAMILY } });
    expect((await getDynasty(SLUG)).head).toBe(`${FAMILY}-v2`);
    expect(guard.assertTemplateNeutral).not.toHaveBeenCalled();
  });

  it("appends an already-stored template as the head (not a twin of itself), once", async () => {
    await seedDynasty("blind");
    const type = `${FAMILY}-v47-spaced`;
    await db.insert(prompts).values({ type, prompt: `${TAG} spaced {{leadFirstName}} {{brands}}`, variables: VARS });
    const { dynasty, template } = await addDynastyVersion({ slug: SLUG, version: { type }, orgId: null, caller: CALLER, changedBy: BY });
    expect(template.type).toBe(type);
    expect(dynasty.head).toBe(type);
    expect(dynasty.versions.map((v) => v.position)).toEqual([1, 2, 3]);
    expect(guard.assertBlindTemplateKeepsClientAnonymous).toHaveBeenCalledWith(expect.objectContaining({ type, blind: true }));
    await expect(addDynastyVersion({ slug: SLUG, version: { type }, orgId: null, caller: CALLER, changedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "ALREADY_IN_DYNASTY" });
    await expect(addDynastyVersion({ slug: SLUG, version: { type: `${TAG}-nope` }, orgId: null, caller: CALLER, changedBy: BY }))
      .rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE" });
    // A stored template whose text duplicates another one is still a twin.
    await db.insert(prompts).values({ type: `${FAMILY}-dup`, prompt: `${TAG} v1 {{leadFirstName}} {{brands}}`, variables: VARS });
    await expect(addDynastyVersion({ slug: SLUG, version: { type: `${FAMILY}-dup` }, orgId: null, caller: CALLER, changedBy: BY }))
      .rejects.toMatchObject({ code: "TEMPLATE_TWIN", extra: { twinType: FAMILY } });
  });

  it("refuses a token the head does not declare, and an unknown dynasty", async () => {
    await seedDynasty();
    await expect(addDynastyVersion({
      slug: SLUG, version: { prompt: `${TAG} {{newThing}}`, variables: [{ name: "newThing", description: "" }] }, orgId: null, caller: CALLER, changedBy: BY,
    })).rejects.toMatchObject({ code: "VARIABLE_NOT_IN_HEAD" });
    await expect(getDynasty(`${TAG}-missing`)).rejects.toMatchObject({ status: 404, code: "DYNASTY_NOT_FOUND" });
  });

  it("one template may sit in two dynasties (two pipes); create refuses clashes and unknown templates", async () => {
    await seedDynasty();
    const other = await createDynasty({
      slug: `${TAG}-other-pipe`, name: `Name ${SLUG}`, description: `Other ${SLUG}`, signature: `Signature ${SLUG}`,
      identity: "named", featureSlug: PIPE.featureSlug, legKey: "lead_found_to_website_visit", versions: [`${FAMILY}-v2`],
    });
    expect(other.head).toBe(`${FAMILY}-v2`);
    await expect(createDynasty({
      slug: `${TAG}-dup`, name: "x", description: `Description ${SLUG}`, signature: "y", identity: "named", ...PIPE, versions: [FAMILY],
    })).rejects.toMatchObject({ code: "DYNASTY_CONFLICT", extra: { field: "description" } });
    await expect(createDynasty({
      slug: `${TAG}-unknown`, name: "x", description: "z", signature: "y", identity: "named", ...PIPE, versions: [`${TAG}-nope`],
    })).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE" });
  });

  it("creates a dynasty from a brand-new text: first version and head, judged in full, the dynasty's identity drives the blind rule", async () => {
    const text = `${TAG} 8-second test {{leadFirstName}} {{brands}}`;
    const fields = {
      slug: `${TAG}-fresh`, name: "Fresh", description: `Fresh ${TAG}`, signature: `Fresh sig ${TAG}`,
      identity: "blind" as const, ...PIPE,
    };
    const created = await createDynasty({ ...fields, template: { prompt: text, variables: VARS } }, { orgId: null, caller: CALLER });
    expect(created.head).toBe(`${TAG}-fresh-v1`);
    expect(created.versions.map((v) => [v.type, v.position, v.status])).toEqual([[`${TAG}-fresh-v1`, 1, "active"]]);
    expect((await resolveDynastyHead(`${TAG}-fresh`)).template).toMatchObject({ prompt: text, variables: VARS });
    expect(guard.assertTemplateNeutral).toHaveBeenCalledWith(expect.objectContaining({ prompt: text, variables: VARS }));
    expect(guard.assertTemplateNeutral.mock.calls[0][0]).not.toHaveProperty("inherited");
    expect(guard.assertBlindTemplateKeepsClientAnonymous).toHaveBeenCalledWith(expect.objectContaining({ blind: true }));

    // The next version follows the new family.
    const { template } = await addDynastyVersion({
      slug: `${TAG}-fresh`, version: { prompt: `${TAG} 8-second v2 {{leadFirstName}}`, variables: [VARS[0]] }, orgId: null, caller: CALLER, changedBy: BY,
    });
    expect(template.type).toBe(`${TAG}-fresh-v2`);
  });

  it("a new text is refused before anything is stored: mismatch, twin, taken type, not neutral", async () => {
    await seedDynasty();
    const fields = { slug: `${TAG}-refused`, name: "R", description: `R ${TAG}`, signature: `R sig`, identity: "named" as const, ...PIPE };
    const nothingStored = async () => {
      expect(await db.select().from(templateDynasties).where(inArray(templateDynasties.slug, [`${TAG}-refused`]))).toEqual([]);
      expect(await db.select().from(prompts).where(like(prompts.type, `${TAG}-refused%`))).toEqual([]);
    };
    await expect(createDynasty({ ...fields, template: { prompt: `${TAG} {{leadFirstName}} {{x}}`, variables: [VARS[0]] } }, { caller: CALLER }))
      .rejects.toMatchObject({ status: 400, code: "VARIABLES_MISMATCH" });
    await expect(createDynasty({ ...fields, template: { prompt: `${TAG} v1 {{leadFirstName}} {{brands}}`, variables: VARS } }, { caller: CALLER }))
      .rejects.toMatchObject({ status: 409, code: "TEMPLATE_TWIN", extra: { twinType: FAMILY } });
    await expect(createDynasty({ ...fields, template: { type: FAMILY, prompt: `${TAG} other {{leadFirstName}}`, variables: [VARS[0]] } }, { caller: CALLER }))
      .rejects.toMatchObject({ status: 409, code: "TEMPLATE_TYPE_TAKEN" });
    expect(guard.assertTemplateNeutral).not.toHaveBeenCalled();
    const refusal = Object.assign(new Error("not neutral"), { status: 422 });
    guard.assertTemplateNeutral.mockRejectedValueOnce(refusal);
    await expect(createDynasty({ ...fields, template: { prompt: `${TAG} Acme saved $2M {{leadFirstName}}`, variables: [VARS[0]] } }, { caller: CALLER }))
      .rejects.toBe(refusal);
    await nothingStored();
  });

  const statusOf = async (type: string) =>
    (await db.select({ status: prompts.status, reason: prompts.statusReason, by: prompts.statusChangedBy, at: prompts.statusChangedAt })
      .from(prompts).where(inArray(prompts.type, [type])))[0];

  it("a new version leaves only the head Active: the previous head is Deprecated Upgraded, by who added it", async () => {
    await seedDynasty();
    await addDynastyVersion({
      slug: SLUG, version: { prompt: `${TAG} v3 {{leadFirstName}}`, variables: [VARS[0]] }, orgId: null, caller: CALLER, changedBy: BY,
    });
    expect(await statusOf(`${FAMILY}-v2`)).toMatchObject({ status: "deprecated", reason: "Upgraded", by: BY });
    expect((await statusOf(`${FAMILY}-v2`)).at).toBeInstanceOf(Date);
    expect((await statusOf(`${FAMILY}-v3`)).status).toBe("active");
    // v1 was deprecated when the dynasty was created over it.
    expect(await statusOf(FAMILY)).toMatchObject({ status: "deprecated", reason: "Upgraded", by: "template-dynasty-upgrade" });
  });

  it("a previous head that still heads another dynasty stays Active", async () => {
    await seedDynasty();
    await createDynasty({
      slug: `${TAG}-other-pipe`, name: `Name ${SLUG}`, description: `Other ${SLUG}`, signature: `Signature ${SLUG}`,
      identity: "named", featureSlug: PIPE.featureSlug, legKey: "lead_found_to_website_visit", versions: [`${FAMILY}-v2`],
    });
    await addDynastyVersion({
      slug: SLUG, version: { prompt: `${TAG} v3 {{leadFirstName}}`, variables: [VARS[0]] }, orgId: null, caller: CALLER, changedBy: BY,
    });
    expect((await statusOf(`${FAMILY}-v2`)).status).toBe("active");
    // Active as a template (it heads the other pipe's dynasty), Deprecated Upgraded in this one.
    const d = await getDynasty(SLUG);
    const v2 = d.versions.find((v) => v.type === `${FAMILY}-v2`)!;
    expect([v2.status, v2.statusInDynasty, v2.statusReasonInDynasty]).toEqual(["active", "deprecated", "Upgraded"]);
    expect(d.versions.filter((v) => v.statusInDynasty === "active").map((v) => v.type)).toEqual([`${FAMILY}-v3`]);
    expect((await getDynasty(`${TAG}-other-pipe`)).status).toBe("active");
  });

  it("the backfill deprecates every non-head version, never a head, keeps a stated reason, and is idempotent", async () => {
    await seedDynasty();
    const only = [FAMILY, `${FAMILY}-v2`, `${FAMILY}-v3`];
    await db.insert(prompts).values({ type: `${FAMILY}-v3`, prompt: `${TAG} v3 {{leadFirstName}} {{brands}}`, variables: VARS, status: "deprecated", statusReason: "Deceptive", statusChangedBy: "owner@distribute.you" });
    await db.insert(templateDynastyVersions).values({ dynastySlug: SLUG, promptType: `${FAMILY}-v3`, position: 3 });
    // v2 also heads another pipe's dynasty: kept active.
    await createDynasty({
      slug: `${TAG}-other-pipe`, name: `Name ${SLUG}`, description: `Other ${SLUG}`, signature: `Signature ${SLUG}`,
      identity: "named", featureSlug: PIPE.featureSlug, legKey: "lead_found_to_website_visit", versions: [FAMILY, `${FAMILY}-v2`],
    });
    // Data from before creation deprecated older versions: v1 still Active.
    await db.execute(sql`UPDATE prompts SET status = 'active', status_reason = NULL, status_changed_by = NULL WHERE type = ${FAMILY}`);
    expect(await deprecateUpgradedVersions(db, { changedBy: BY, onlyTypes: only, dryRun: true })).toEqual([FAMILY]);
    await db.delete(templateDynastyVersions).where(inArray(templateDynastyVersions.dynastySlug, [`${TAG}-other-pipe`]));
    await db.delete(templateDynasties).where(inArray(templateDynasties.slug, [`${TAG}-other-pipe`]));

    expect(await deprecateUpgradedVersions(db, { changedBy: BY, onlyTypes: only, dryRun: true })).toEqual([FAMILY, `${FAMILY}-v2`]);
    expect((await statusOf(FAMILY)).status).toBe("active");
    expect(await deprecateUpgradedVersions(db, { changedBy: BY, onlyTypes: only })).toEqual([FAMILY, `${FAMILY}-v2`]);
    expect(await statusOf(FAMILY)).toMatchObject({ status: "deprecated", reason: "Upgraded", by: BY });
    // The head is never deprecated by this rule, and its owner-stated reason stays.
    expect(await statusOf(`${FAMILY}-v3`)).toMatchObject({ status: "deprecated", reason: "Deceptive", by: "owner@distribute.you" });
    expect(await deprecateUpgradedVersions(db, { changedBy: BY, onlyTypes: only })).toEqual([]);
  });

  it("a non-head version can never be re-activated; a head can; a dynasty version is never forked loose", async () => {
    await seedDynasty();
    await expect(assertMayActivate(FAMILY)).rejects.toMatchObject({ status: 409, code: "NOT_DYNASTY_HEAD", extra: { dynasties: [{ slug: SLUG, head: `${FAMILY}-v2` }] } });
    await expect(assertMayActivate(`${FAMILY}-v2`)).resolves.toBeUndefined();
    await db.insert(prompts).values({ type: `${TAG}-loose`, prompt: `${TAG} loose`, variables: [] });
    await expect(assertMayActivate(`${TAG}-loose`)).resolves.toBeUndefined();
    await expect(assertNotDynastySource(FAMILY)).rejects.toMatchObject({ code: "SOURCE_IN_DYNASTY", extra: { dynasties: [SLUG] } });
    await expect(assertNotDynastySource(`${TAG}-loose`)).resolves.toBeUndefined();
  });

  it("serves the last outputs across every version of a dynasty, newest first, limited", async () => {
    await seedDynasty();
    const row = (promptType: string, at: string) => ({
      orgId: "11111111-1111-1111-1111-111111111111", runId: randomId(), campaignId: `${TAG}-c`, leadId: randomId(),
      model: "m", promptType, subject: `${promptType} subject`, createdAt: new Date(at),
      sequence: [{ step: 1, bodyText: `${promptType} body`, daysSinceLastStep: 0 }],
    });
    await db.insert(emailGenerations).values([
      row(FAMILY, "2026-10-01T00:00:00Z"),
      row(`${FAMILY}-v2`, "2026-10-03T00:00:00Z"),
      row(FAMILY, "2026-10-02T00:00:00Z"),
    ]);
    const { outputs } = await readDynastyOutputs(SLUG, 2);
    expect(outputs.map((o) => [o.promptType, o.createdAt])).toEqual([
      [`${FAMILY}-v2`, "2026-10-03T00:00:00.000Z"],
      [FAMILY, "2026-10-02T00:00:00.000Z"],
    ]);
    expect(outputs[0].emails).toEqual([{ step: 1, bodyText: `${FAMILY}-v2 body`, daysSinceLastStep: 0 }]);
    await expect(readDynastyOutputs(`${TAG}-missing`, 5)).rejects.toMatchObject({ code: "DYNASTY_NOT_FOUND" });
  });
});
