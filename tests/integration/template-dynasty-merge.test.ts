import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";

// No text is judged by a merge; the guard is stubbed only because createDynasty imports it.
vi.mock("../../src/lib/template-neutrality-guard.js", () => ({
  assertTemplateNeutral: vi.fn(async () => undefined),
  assertTemplateKeepsDynastyIdentity: vi.fn(async () => undefined),
}));
// tests/setup.ts stubs dynasty membership as "in no dynasty"; this suite needs the real read.
vi.mock("../../src/lib/dynasty-membership.js", async (importOriginal) => importOriginal());

const { db } = await import("../../src/db/index.js");
const { prompts, templateDynasties, templateDynastyVersions } = await import("../../src/db/schema.js");
const { addDynastyVersion, createDynasty, getDynasty, listDynasties, mergeDynasty, readDynastyOutputs, resolveDynastyHead } = await import(
  "../../src/lib/template-dynasty-query.js"
);
const { emailGenerations } = await import("../../src/db/schema.js");
const { closeDb, randomId } = await import("../helpers/test-db.js");

const TAG = `tplmrg${randomId().slice(0, 8)}`;
const PIPE = { featureSlug: `${TAG}-feature`, legKey: "lead_found_to_conversation" };
const VARS = [{ name: "leadFirstName", description: "first name" }];
const BY = "kevin@distribute.you";

const cleanup = async () => {
  await db.delete(emailGenerations).where(like(emailGenerations.promptType, `${TAG}%`));
  await db.delete(templateDynastyVersions).where(like(templateDynastyVersions.dynastySlug, `${TAG}%`));
  await db.update(templateDynasties).set({ mergedInto: null }).where(like(templateDynasties.slug, `${TAG}%`));
  await db.delete(templateDynasties).where(like(templateDynasties.slug, `${TAG}%`));
  await db.delete(prompts).where(like(prompts.type, `${TAG}%`));
};

/** A dynasty `name` with `n` versions `<name>-v1..vn`; only the head stays active. */
async function seed(name: string, n: number, opts: { identity?: "blind" | "named"; legKey?: string } = {}) {
  const slug = `${TAG}-${name}`;
  const types = Array.from({ length: n }, (_, i) => `${slug}-v${i + 1}`);
  await db.insert(prompts).values(types.map((type) => ({ type, prompt: `${type} {{leadFirstName}}`, variables: VARS })));
  await createDynasty({
    slug, name: `Name ${slug}`, description: `Description ${slug}`, signature: `Signature ${slug}`,
    identity: opts.identity ?? "blind", featureSlug: PIPE.featureSlug, legKey: opts.legKey ?? PIPE.legKey, versions: types,
  });
  return { slug, types };
}

describe("merge a template dynasty into another (MERGE-TEMPLATE-DYNASTY-1023)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("source versions become the target's OLDER deprecated versions; the target's head never moves", async () => {
    const x = await seed("x", 2);
    const y = await seed("y", 3);
    // The source head is already deprecated (like the 4 owner merges): its stated reason is kept.
    await db.update(prompts).set({ status: "deprecated", statusReason: "Bad opener", statusChangedBy: BY }).where(eq(prompts.type, x.types[1]));

    const out = await mergeDynasty({ source: x.slug, into: y.slug, reason: "Same approach", mergedBy: BY });

    expect(out.merged).toBe(x.slug);
    expect(out.movedVersions).toEqual(x.types);
    expect(out.deprecated).toEqual([]);
    expect(out.dynasty.slug).toBe(y.slug);
    expect(out.dynasty.head).toBe(y.types[2]);
    expect(out.dynasty.versions.map((v) => [v.type, v.position, v.statusInDynasty])).toEqual([
      [x.types[0], 1, "deprecated"],
      [x.types[1], 2, "deprecated"],
      [y.types[0], 3, "deprecated"],
      [y.types[1], 4, "deprecated"],
      [y.types[2], 5, "active"],
    ]);
    expect(out.dynasty.versions[1].statusReasonInDynasty).toBe("Bad opener");
    expect(out.dynasty.status).toBe("active");
    expect(out.dynasty.mergedDynasties).toEqual([
      { slug: x.slug, name: `Name ${x.slug}`, mergedAt: expect.any(String), mergedBy: BY, reason: "Same approach" },
    ]);
    expect((await resolveDynastyHead(y.slug)).template.type).toBe(y.types[2]);
  });

  it("a source version still active is deprecated with the merge reason, by who merged", async () => {
    const x = await seed("x", 1);
    const y = await seed("y", 1);
    const out = await mergeDynasty({ source: x.slug, into: y.slug, reason: "Same approach", mergedBy: BY });
    expect(out.deprecated).toEqual([x.types[0]]);
    const [row] = await db.select().from(prompts).where(eq(prompts.type, x.types[0]));
    expect(row).toMatchObject({ status: "deprecated", statusReason: `Merged into ${y.slug}: Same approach`, statusChangedBy: BY });
    // The target's own head is untouched.
    const [head] = await db.select().from(prompts).where(eq(prompts.type, y.types[0]));
    expect(head.status).toBe("active");
  });

  it("the merged dynasty leaves the list, its slug resolves to the target, its outputs read as the target's, it takes no write", async () => {
    const x = await seed("x", 1);
    const y = await seed("y", 1);
    await db.insert(emailGenerations).values({
      orgId: "00000000-0000-4000-8000-000000000001", runId: `${TAG}-run`, model: "m", promptType: x.types[0], subject: "From X",
      sequence: [{ step: 1, bodyText: "x body", daysSinceLastStep: 0 }], campaignId: `${TAG}-c`, leadId: `${TAG}-l`,
    });
    await mergeDynasty({ source: x.slug, into: y.slug, reason: "Same approach", mergedBy: BY });

    expect((await listDynasties(PIPE)).map((d) => d.slug)).toEqual([y.slug]);
    expect((await getDynasty(x.slug)).slug).toBe(y.slug);
    expect((await resolveDynastyHead(x.slug)).template.type).toBe(y.types[0]);
    const { outputs } = await readDynastyOutputs(y.slug, 5);
    expect(outputs.map((o) => [o.promptType, o.subject])).toEqual([[x.types[0], "From X"]]);

    await expect(addDynastyVersion({ slug: x.slug, version: { type: y.types[0] }, orgId: null, caller: { mode: "platform" }, changedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "DYNASTY_MERGED", extra: { mergedInto: y.slug } });
    await expect(mergeDynasty({ source: x.slug, into: y.slug, reason: "again", mergedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "DYNASTY_MERGED" });
    const z = await seed("z", 1);
    await expect(mergeDynasty({ source: z.slug, into: x.slug, reason: "into a merged one", mergedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "DYNASTY_MERGED" });
  });

  it("refuses another pipe, another identity, itself and an unknown dynasty; nothing written", async () => {
    const x = await seed("x", 2);
    const named = await seed("named", 1, { identity: "named" });
    const click = await seed("click", 1, { legKey: "lead_found_to_website_visit" });

    await expect(mergeDynasty({ source: x.slug, into: click.slug, reason: "r", mergedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "DIFFERENT_PIPE" });
    await expect(mergeDynasty({ source: x.slug, into: named.slug, reason: "r", mergedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "DIFFERENT_IDENTITY" });
    await expect(mergeDynasty({ source: named.slug, into: x.slug, reason: "r", mergedBy: BY }))
      .rejects.toMatchObject({ status: 409, code: "DIFFERENT_IDENTITY" });
    await expect(mergeDynasty({ source: x.slug, into: x.slug, reason: "r", mergedBy: BY }))
      .rejects.toMatchObject({ status: 400, code: "SAME_DYNASTY" });
    await expect(mergeDynasty({ source: x.slug, into: `${TAG}-nope`, reason: "r", mergedBy: BY }))
      .rejects.toMatchObject({ status: 404, code: "DYNASTY_NOT_FOUND" });

    const after = await getDynasty(x.slug);
    expect(after.slug).toBe(x.slug);
    expect(after.versions.map((v) => [v.type, v.position])).toEqual([[x.types[0], 1], [x.types[1], 2]]);
    expect(after.mergedDynasties).toEqual([]);
    expect((await listDynasties(PIPE)).map((d) => d.slug).sort()).toEqual([named.slug, x.slug].sort());
  });

  it("two merges into one target stack in merge order, oldest at the bottom", async () => {
    const a = await seed("a", 1);
    const b = await seed("b", 2);
    const y = await seed("y", 1);
    await mergeDynasty({ source: a.slug, into: y.slug, reason: "first", mergedBy: BY });
    const out = await mergeDynasty({ source: b.slug, into: y.slug, reason: "second", mergedBy: BY });
    expect(out.dynasty.versions.map((v) => v.type)).toEqual([...b.types, ...a.types, ...y.types]);
    expect(out.dynasty.head).toBe(y.types[0]);
    expect(out.dynasty.mergedDynasties.map((m) => m.slug)).toEqual([a.slug, b.slug]);
  });
});
