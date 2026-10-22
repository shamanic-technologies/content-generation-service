import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations, modelStatuses, prompts } from "../../src/db/schema.js";
import {
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

const cleanup = async () => {
  await db.delete(emailGenerations).where(inArray(emailGenerations.promptType, [TYPE, OTHER_TYPE]));
  await db.delete(prompts).where(inArray(prompts.type, [TYPE, OTHER_TYPE]));
  await db.delete(modelStatuses).where(eq(modelStatuses.model, MODEL));
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

  it("every model reads active until staff changes it, both ways", async () => {
    const initial = (await listModelStatuses()).find((m) => m.model === MODEL)!;
    expect(initial).toEqual({
      model: MODEL, provider: "moonshot", dynasty: "kimi-k2", status: "active", statusChangedAt: null, statusReason: null, statusChangedBy: null,
    });

    expect((await setModelStatus(ENTRY, DEPRECATE)).statusReason).toBe("Writes one block");
    expect((await listModelStatuses()).find((m) => m.model === MODEL)).toMatchObject({
      status: "deprecated", statusReason: "Writes one block", statusChangedBy: "kevin@distribute.you",
    });
    expect((await setModelStatus(ENTRY, ACTIVATE)).statusReason).toBeNull();
    expect((await listModelStatuses()).find((m) => m.model === MODEL)!.status).toBe("active");
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
