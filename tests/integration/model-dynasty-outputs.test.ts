import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

const resolveModelDynastyVersions = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/model-dynasty-client.js", () => ({ resolveModelDynastyVersions }));

const { db } = await import("../../src/db/index.js");
const { emailGenerations, whatsappGenerations, prompts, templateDynasties, templateDynastyVersions } = await import("../../src/db/schema.js");
const { readModelDynastyOutputs } = await import("../../src/lib/model-dynasty-outputs.js");
const { closeDb, randomId } = await import("../helpers/test-db.js");

const tag = randomId().slice(0, 8);
const FEATURE = `model-outputs-feature-${tag}`;
const LEG = `leg-${tag}`;
const OTHER_LEG = `other-leg-${tag}`;
const TYPE = `model-outputs-tpl-${tag}-v1`;
const TYPE_V2 = `model-outputs-tpl-${tag}-v2`;
const OTHER_PIPE_TYPE = `model-outputs-other-${tag}-v1`;
const LOOSE_TYPE = `model-outputs-loose-${tag}`;
const WA_TYPE = `model-outputs-wa-${tag}-v1`;
const DYNASTY = `model-outputs-dynasty-${tag}`;
const OTHER_DYNASTY = `model-outputs-other-dynasty-${tag}`;
const WA_DYNASTY = `model-outputs-wa-dynasty-${tag}`;
const ALL_TYPES = [TYPE, TYPE_V2, OTHER_PIPE_TYPE, LOOSE_TYPE, WA_TYPE];

const cleanup = async () => {
  await db.delete(emailGenerations).where(inArray(emailGenerations.promptType, ALL_TYPES));
  await db.delete(whatsappGenerations).where(inArray(whatsappGenerations.promptType, ALL_TYPES));
  await db.delete(templateDynastyVersions).where(inArray(templateDynastyVersions.dynastySlug, [DYNASTY, OTHER_DYNASTY, WA_DYNASTY]));
  await db.delete(templateDynasties).where(inArray(templateDynasties.slug, [DYNASTY, OTHER_DYNASTY, WA_DYNASTY]));
  await db.delete(prompts).where(inArray(prompts.type, ALL_TYPES));
};

async function insertGen(promptType: string, model: string, subject: string, createdAt: Date) {
  await db.insert(emailGenerations).values({
    orgId: randomId(),
    runId: `run-${subject}`,
    leadId: randomId(),
    campaignId: randomId(),
    brandIds: [randomId()],
    promptType,
    model,
    workflowSlug: `wf-${tag}`,
    subject,
    tokensInput: 1200,
    tokensOutput: 300,
    sequence: [
      { step: 1, bodyText: `${subject} body 1`, bodyHtml: "<p>x</p>", daysSinceLastStep: 0 },
      { step: 2, bodyText: `${subject} body 2`, bodyHtml: "<p>y</p>", daysSinceLastStep: 3 },
    ],
    createdAt,
  });
}

async function insertWa(decision: "write" | "later", model: string, bubbles: string[], createdAt: Date) {
  await db.insert(whatsappGenerations).values({
    orgId: randomId(), runId: `wa-run-${tag}`, brandIds: [randomId()], campaignId: randomId(), leadId: randomId(),
    workflowSlug: `wa-wf-${tag}`, featureSlug: FEATURE, promptType: WA_TYPE, model, decision, bubbles,
    tokensInput: 900, tokensOutput: 80, createdAt,
  });
}

describe("readModelDynastyOutputs", () => {
  beforeEach(async () => {
    await cleanup();
    resolveModelDynastyVersions.mockReset();
    resolveModelDynastyVersions.mockResolvedValue({ slug: "gemini-pro", name: "Gemini Pro", modelIds: ["gemini-3.2-pro", "gemini-3.1-pro-preview"] });
    await db.insert(prompts).values(ALL_TYPES.map((type) => ({ type, prompt: "Hi {{name}}", variables: [{ name: "name", description: "n" }] })));
    await db.insert(templateDynasties).values([
      { slug: DYNASTY, name: `Short ${tag}`, description: `desc ${tag}`, signature: `sig ${tag}`, identity: "named", featureSlug: FEATURE, legKey: LEG },
      { slug: WA_DYNASTY, name: `WA ${tag}`, description: `wa desc ${tag}`, signature: `wa sig ${tag}`, identity: "named", featureSlug: FEATURE, legKey: LEG },
      { slug: OTHER_DYNASTY, name: `Other ${tag}`, description: `other desc ${tag}`, signature: `other sig ${tag}`, identity: "named", featureSlug: FEATURE, legKey: OTHER_LEG },
    ]);
    await db.insert(templateDynastyVersions).values([
      { dynastySlug: DYNASTY, promptType: TYPE, position: 1 },
      { dynastySlug: DYNASTY, promptType: TYPE_V2, position: 2 },
      { dynastySlug: WA_DYNASTY, promptType: WA_TYPE, position: 1 },
      { dynastySlug: OTHER_DYNASTY, promptType: OTHER_PIPE_TYPE, position: 1 },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns every version's messages on the pipe, newest first, emails and WhatsApp, with template, model and tokens", async () => {
    await insertGen(TYPE, "gemini-3.1-pro-preview", "old", new Date("2026-10-20T10:00:00Z"));
    await insertGen(TYPE_V2, "gemini-3.2-pro", "new", new Date("2026-10-22T10:00:00Z"));
    await insertGen(TYPE_V2, "claude-opus-5-5", "other-model", new Date("2026-10-22T12:00:00Z"));
    await insertGen(OTHER_PIPE_TYPE, "gemini-3.2-pro", "other-pipe", new Date("2026-10-22T13:00:00Z"));
    await insertGen(LOOSE_TYPE, "gemini-3.2-pro", "no-dynasty", new Date("2026-10-22T14:00:00Z"));
    await insertWa("write", "gemini-3.2-pro", ["Hi", "How is it going?"], new Date("2026-10-21T10:00:00Z"));
    await insertWa("later", "gemini-3.2-pro", [], new Date("2026-10-23T10:00:00Z"));

    const { name, modelIds, outputs } = await readModelDynastyOutputs({ slug: "gemini-pro", featureSlug: FEATURE, legKey: LEG, limit: 10 });
    expect(name).toBe("Gemini Pro");
    expect(modelIds).toEqual(["gemini-3.2-pro", "gemini-3.1-pro-preview"]);
    expect(outputs.map((o) => o.subject ?? o.channel)).toEqual(["new", "whatsapp", "old"]);
    expect(outputs[0]).toMatchObject({
      channel: "email", workflowSlug: `wf-${tag}`, promptType: TYPE_V2, model: "gemini-3.2-pro",
      templateDynasty: { slug: DYNASTY, name: `Short ${tag}`, position: 2 },
      tokensInput: 1200, tokensOutput: 300,
    });
    expect(outputs[1]).toMatchObject({
      channel: "whatsapp", promptType: WA_TYPE, tokensInput: 900, tokensOutput: 80,
      emails: [{ step: 1, bodyText: "Hi\n\nHow is it going?", daysSinceLastStep: 0 }],
    });
    expect(outputs[2]).toMatchObject({
      model: "gemini-3.1-pro-preview",
      emails: [
        { step: 1, bodyText: "old body 1", daysSinceLastStep: 0 },
        { step: 2, bodyText: "old body 2", daysSinceLastStep: 3 },
      ],
    });
    for (const o of outputs) {
      expect(Object.keys(o)).not.toEqual(expect.arrayContaining(["orgId", "leadId", "campaignId", "brandIds", "runId"]));
    }

    const one = await readModelDynastyOutputs({ slug: "gemini-pro", featureSlug: FEATURE, legKey: LEG, limit: 1 });
    expect(one.outputs.map((o) => o.subject)).toEqual(["new"]);
  });

  it("a dynasty that never wrote on the pipe returns an empty list", async () => {
    await insertGen(OTHER_PIPE_TYPE, "gemini-3.2-pro", "other-pipe", new Date("2026-10-22T13:00:00Z"));
    const { outputs } = await readModelDynastyOutputs({ slug: "gemini-pro", featureSlug: FEATURE, legKey: LEG, limit: 5 });
    expect(outputs).toEqual([]);
  });
});
