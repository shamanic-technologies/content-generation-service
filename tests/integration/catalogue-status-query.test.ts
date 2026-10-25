import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations, modelPipeStatuses, prompts } from "../../src/db/schema.js";
import {
  alignModelDynastyStatuses,
  listModelStatuses,
  listTemplateStatuses,
  readTemplateOutputs,
  setModelStatus,
  setTemplateStatus,
} from "../../src/lib/catalogue-status-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

const TYPE = `catalogue-status-test-${randomId().slice(0, 8)}`;
const OTHER_TYPE = `${TYPE}-other`;
const MODEL = "kimi-flash";
const ENTRY = { model: MODEL, provider: "moonshot" as const, dynasty: "kimi-k2" };
const DEPRECATE = { status: "deprecated" as const, reason: "Writes one block", changedBy: "kevin@distribute.you" };
const ACTIVATE = { status: "active" as const, reason: null, changedBy: "kevin@distribute.you" };
// The fixture catalogue's names of two dynasties (tests/fixtures/chat-service-models-2026-10-22.json).
const KIMI_K2 = ["kimi-k2", "kimi-k2.6", "kimi-flash"];
const KIMI_K3 = ["kimi-k3", "kimi-pro"];
const VISIT = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit" };
const REPLY = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" };

const cleanup = async () => {
  await db.delete(emailGenerations).where(inArray(emailGenerations.promptType, [TYPE, OTHER_TYPE]));
  await db.delete(prompts).where(inArray(prompts.type, [TYPE, OTHER_TYPE]));
  await db.delete(modelPipeStatuses).where(inArray(modelPipeStatuses.model, [...KIMI_K2, ...KIMI_K3]));
};

async function insertGen(promptType: string, subject: string, createdAt: Date) {
  await db.insert(emailGenerations).values({
    orgId: randomId(),
    runId: `run-${randomId()}`,
    leadId: randomId(),
    campaignId: randomId(),
    brandIds: [randomId()],
    promptType,
    workflowSlug: "wf-v1",
    subject,
    sequence: [
      { step: 1, bodyText: `${subject} body 1`, bodyHtml: "<p>x</p>", daysSinceLastStep: 0 },
      { step: 2, bodyText: `${subject} body 2`, bodyHtml: "<p>y</p>", daysSinceLastStep: 3 },
    ],
    createdAt,
  });
}

describe("catalogue status (templates + models)", () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(prompts).values({ type: TYPE, prompt: "Hi {{name}}", variables: [{ name: "name", description: "n" }] });
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("a template reads active by default, goes deprecated and back, body untouched", async () => {
    const before = await db.query.prompts.findFirst({ where: eq(prompts.type, TYPE) });
    expect(before!.status).toBe("active");
    expect(before!.statusChangedAt).toBeNull();

    const dep = await setTemplateStatus(TYPE, DEPRECATE);
    expect(dep).toMatchObject({ type: TYPE, status: "deprecated", statusReason: "Writes one block", statusChangedBy: "kevin@distribute.you" });
    expect(dep!.statusChangedAt).not.toBeNull();
    expect((await listTemplateStatuses()).find((t) => t.type === TYPE)!.status).toBe("deprecated");

    const back = await setTemplateStatus(TYPE, ACTIVATE);
    expect(back).toMatchObject({ status: "active", statusReason: null });

    const after = await db.query.prompts.findFirst({ where: eq(prompts.type, TYPE) });
    expect(after!.prompt).toBe(before!.prompt);
    expect(after!.variables).toEqual(before!.variables);
    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
  });

  it("a template deprecated before reasons existed reads Not specified, no author", async () => {
    await db.update(prompts).set({ status: "deprecated", statusChangedAt: new Date() }).where(eq(prompts.type, TYPE));
    expect((await listTemplateStatuses()).find((t) => t.type === TYPE)).toMatchObject({
      status: "deprecated", statusReason: "Not specified", statusChangedBy: null,
    });
  });

  it("an unknown template type is null", async () => {
    expect(await setTemplateStatus(`${TYPE}-missing`, DEPRECATE)).toBeNull();
  });

  it("every model reads active on every pipe until staff changes it, both ways", async () => {
    const initial = (await listModelStatuses()).find((m) => m.model === MODEL)!;
    expect(initial).toEqual({
      model: MODEL, provider: "moonshot", dynasty: "kimi-k2", status: "active", statusChangedAt: null, statusReason: null, statusChangedBy: null,
      pipe: null, pipeStatuses: [],
    });

    expect((await setModelStatus(ENTRY, VISIT, DEPRECATE)).statusReason).toBe("Writes one block");
    expect((await listModelStatuses(VISIT)).find((m) => m.model === MODEL)).toMatchObject({
      status: "deprecated", statusReason: "Writes one block", statusChangedBy: "kevin@distribute.you", pipe: VISIT,
    });
    expect((await setModelStatus(ENTRY, VISIT, ACTIVATE)).statusReason).toBeNull();
    expect((await listModelStatuses(VISIT)).find((m) => m.model === MODEL)!.status).toBe("active");
  });

  it("deprecating a model on one pipe leaves it active on every other, and without a pipe", async () => {
    await setModelStatus(ENTRY, VISIT, DEPRECATE);
    expect((await listModelStatuses(VISIT)).find((m) => m.model === MODEL)!.status).toBe("deprecated");
    expect((await listModelStatuses(REPLY)).find((m) => m.model === MODEL)).toMatchObject({ status: "active", statusReason: null, pipe: REPLY });
    const noPipe = (await listModelStatuses()).find((m) => m.model === MODEL)!;
    expect(noPipe).toMatchObject({ status: "active", statusReason: null, pipe: null });
    expect(noPipe.pipeStatuses).toEqual([
      expect.objectContaining({ ...VISIT, status: "deprecated", statusReason: "Writes one block", statusChangedBy: "kevin@distribute.you" }),
    ]);
  });

  it("deprecating one name deprecates every name of its dynasty on that pipe, same reason/author/date; other pipes and dynasties unchanged", async () => {
    await setModelStatus({ model: "kimi-pro", provider: "moonshot", dynasty: "kimi-k3" }, REPLY, { ...DEPRECATE, reason: "Too expensive" });
    const onReply = (await listModelStatuses(REPLY)).filter((m) => KIMI_K3.includes(m.model));
    expect(onReply.map((m) => m.model).sort()).toEqual([...KIMI_K3].sort());
    for (const m of onReply) {
      expect(m).toMatchObject({ status: "deprecated", statusReason: "Too expensive", statusChangedBy: "kevin@distribute.you" });
    }
    expect(new Set(onReply.map((m) => m.statusChangedAt)).size).toBe(1);
    const stored = await db.select().from(modelPipeStatuses).where(inArray(modelPipeStatuses.model, KIMI_K3));
    expect(stored.map((r) => r.model).sort()).toEqual([...KIMI_K3].sort());

    expect((await listModelStatuses(VISIT)).filter((m) => KIMI_K3.includes(m.model)).every((m) => m.status === "active")).toBe(true);
    expect((await listModelStatuses(REPLY)).filter((m) => KIMI_K2.includes(m.model)).every((m) => m.status === "active")).toBe(true);
  });

  it("re-activating any one name restores the whole dynasty on that pipe", async () => {
    await setModelStatus({ model: "kimi-pro", provider: "moonshot", dynasty: "kimi-k3" }, REPLY, DEPRECATE);
    await setModelStatus({ model: "kimi-k3", provider: "moonshot", dynasty: "kimi-k3" }, REPLY, ACTIVATE);
    const onReply = (await listModelStatuses(REPLY)).filter((m) => KIMI_K3.includes(m.model));
    expect(onReply.every((m) => m.status === "active" && m.statusReason === null)).toBe(true);
    const stored = await db.select().from(modelPipeStatuses).where(inArray(modelPipeStatuses.model, KIMI_K3));
    expect(stored.every((r) => r.status === "active")).toBe(true);
  });

  it("a split dynasty (one name deprecated, a sibling with no row) serves and is aligned to one status", async () => {
    const at = new Date("2026-10-24T10:00:00Z");
    await db.insert(modelPipeStatuses).values({ model: "kimi-pro", ...REPLY, status: "deprecated", statusReason: "Too expensive", statusChangedBy: "kevin@distribute.you", statusChangedAt: at });
    expect((await listModelStatuses(REPLY)).find((m) => m.model === "kimi-k3")!.status).toBe("deprecated");
    expect(await alignModelDynastyStatuses()).toBeGreaterThanOrEqual(1);
    const [k3] = await db.select().from(modelPipeStatuses).where(eq(modelPipeStatuses.model, "kimi-k3"));
    expect(k3).toMatchObject({ status: "deprecated", statusReason: "Too expensive", statusChangedBy: "kevin@distribute.you", ...REPLY });
    expect(k3.statusChangedAt.toISOString()).toBe(at.toISOString());
  });

  it("reads the last N outputs of one template, newest first, nothing private", async () => {
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 7; i++) await insertGen(TYPE, `s${i}`, new Date(t0 + i * 1000));
    await insertGen(OTHER_TYPE, "other", new Date(t0 + 99_000));

    const outputs = await readTemplateOutputs(TYPE, 5);
    expect(outputs.map((o) => o.subject)).toEqual(["s6", "s5", "s4", "s3", "s2"]);
    expect(outputs[0].emails).toEqual([
      { step: 1, bodyText: "s6 body 1", daysSinceLastStep: 0 },
      { step: 2, bodyText: "s6 body 2", daysSinceLastStep: 3 },
    ]);
    expect(Object.keys(outputs[0]).sort()).toEqual(["createdAt", "emails", "generationId", "model", "subject", "workflowSlug"]);
  });
});
