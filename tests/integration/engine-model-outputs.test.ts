import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import type { ChannelCatalogue } from "../../src/lib/pipe-from-step.js";

// RESEARCH-BY-ENGINE-1113-CG: an LLM's last outputs for ONE Engine, every pair of the Engine pooled.
const resolveModelDynastyVersions = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/model-dynasty-client.js", () => ({ resolveModelDynastyVersions }));

const tag = Math.random().toString(36).slice(2, 10);
const FEATURE = `engine-outputs-feature-${tag}`;
const WA_FEATURE = `engine-outputs-wa-${tag}`;
const LEG = `lead_found_to_conversation_${tag}`;
const VISIT_LEG = `lead_found_to_website_visit_${tag}`;
const ENGINE = `email_sent_${tag}`;

// Two channels' pairs on the Engine, one pair on another (its `to` step).
const catalogue: ChannelCatalogue = {
  channels: [
    { slug: FEATURE, stepTransitions: [
      { legKey: LEG, from: { key: "lead_found" }, to: { key: "conversation" }, outcome: ENGINE },
      { legKey: VISIT_LEG, from: { key: "lead_found" }, to: { key: `website_visit_${tag}` }, outcome: null },
    ] },
    { slug: WA_FEATURE, stepTransitions: [{ legKey: LEG, from: { key: "lead_found" }, to: { key: "conversation" }, outcome: ENGINE }] },
  ],
};
vi.mock("../../src/lib/pipe-from-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/pipe-from-step.js")>();
  return { ...actual, fetchChannelCatalogue: vi.fn(async () => catalogue) };
});

const { db } = await import("../../src/db/index.js");
const { emailGenerations, whatsappGenerations, threadGenerations, prompts, templateDynasties, templateDynastyVersions } = await import("../../src/db/schema.js");
const { readEngineModelOutputs } = await import("../../src/lib/engine-model-outputs.js");
const { closeDb, randomId } = await import("../helpers/test-db.js");

const TYPE = `engine-outputs-tpl-${tag}-v1`;
const VISIT_TYPE = `engine-outputs-visit-${tag}-v1`;
const WA_TYPE = `engine-outputs-wa-${tag}-v1`;
const DYNASTY = `engine-outputs-dynasty-${tag}`;
const VISIT_DYNASTY = `engine-outputs-visit-dynasty-${tag}`;
const WA_DYNASTY = `engine-outputs-wa-dynasty-${tag}`;
const ALL_TYPES = [TYPE, VISIT_TYPE, WA_TYPE];
const ALL_DYNASTIES = [DYNASTY, VISIT_DYNASTY, WA_DYNASTY];

const cleanup = async () => {
  await db.delete(emailGenerations).where(inArray(emailGenerations.promptType, ALL_TYPES));
  await db.delete(whatsappGenerations).where(inArray(whatsappGenerations.promptType, ALL_TYPES));
  await db.delete(threadGenerations).where(inArray(threadGenerations.promptType, ALL_TYPES));
  await db.delete(templateDynastyVersions).where(inArray(templateDynastyVersions.dynastySlug, ALL_DYNASTIES));
  await db.delete(templateDynasties).where(inArray(templateDynasties.slug, ALL_DYNASTIES));
  await db.delete(prompts).where(inArray(prompts.type, ALL_TYPES));
};

async function insertGen(promptType: string, model: string, subject: string, createdAt: Date) {
  await db.insert(emailGenerations).values({
    orgId: randomId(), runId: `run-${subject}`, leadId: randomId(), campaignId: randomId(), brandIds: [randomId()],
    promptType, model, workflowSlug: `wf-${tag}`, subject, tokensInput: 1200, tokensOutput: 300,
    sequence: [{ step: 1, bodyText: `${subject} body`, bodyHtml: "<p>x</p>", daysSinceLastStep: 0 }],
    createdAt,
  });
}

describe("readEngineModelOutputs", () => {
  beforeEach(async () => {
    await cleanup();
    resolveModelDynastyVersions.mockReset();
    resolveModelDynastyVersions.mockResolvedValue({ slug: "gpt-sol", name: "GPT Sol", modelIds: ["gpt-sol-2", "gpt-sol-1"] });
    await db.insert(prompts).values(ALL_TYPES.map((type) => ({ type, prompt: "Hi {{name}}", variables: [{ name: "name", description: "n" }] })));
    await db.insert(templateDynasties).values([
      { slug: DYNASTY, name: `Email ${tag}`, description: `d1 ${tag}`, signature: `s1 ${tag}`, identity: "named", featureSlug: FEATURE, legKey: LEG },
      { slug: VISIT_DYNASTY, name: `Visit ${tag}`, description: `d2 ${tag}`, signature: `s2 ${tag}`, identity: "named", featureSlug: FEATURE, legKey: VISIT_LEG },
      { slug: WA_DYNASTY, name: `WA ${tag}`, description: `d3 ${tag}`, signature: `s3 ${tag}`, identity: "named", featureSlug: WA_FEATURE, legKey: LEG },
    ]);
    await db.insert(templateDynastyVersions).values([
      { dynastySlug: DYNASTY, promptType: TYPE, position: 1 },
      { dynastySlug: VISIT_DYNASTY, promptType: VISIT_TYPE, position: 1 },
      { dynastySlug: WA_DYNASTY, promptType: WA_TYPE, position: 1 },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("pools every template dynasty of the Engine, every medium, newest first, in Engine words", async () => {
    await insertGen(TYPE, "gpt-sol-1", "old", new Date("2026-11-10T10:00:00Z"));
    await insertGen(TYPE, "gpt-sol-2", "new", new Date("2026-11-12T10:00:00Z"));
    await insertGen(TYPE, "claude-opus-5-5", "other-llm", new Date("2026-11-13T10:00:00Z"));
    await insertGen(VISIT_TYPE, "gpt-sol-2", "other-engine", new Date("2026-11-14T10:00:00Z"));
    await db.insert(whatsappGenerations).values({
      orgId: randomId(), runId: `wa-${tag}`, brandIds: [randomId()], campaignId: randomId(), leadId: randomId(),
      workflowSlug: `wa-wf-${tag}`, featureSlug: WA_FEATURE, promptType: WA_TYPE, model: "gpt-sol-2", decision: "write",
      bubbles: ["Hi", "Quick one"], tokensInput: 900, tokensOutput: 80, createdAt: new Date("2026-11-11T10:00:00Z"),
    });
    await db.insert(threadGenerations).values([
      { orgId: randomId(), runId: `th-${tag}`, brandIds: [randomId()], campaignId: randomId(), promptType: WA_TYPE, model: "gpt-sol-2", subject: "topic", post: "Post", replies: ["r1"], createdAt: new Date("2026-11-12T12:00:00Z") },
      { orgId: randomId(), runId: `th-dry-${tag}`, brandIds: [randomId()], campaignId: randomId(), promptType: WA_TYPE, model: "gpt-sol-2", subject: "dry", post: "Dry", replies: [], dryRun: true, createdAt: new Date("2026-11-15T12:00:00Z") },
    ]);

    const { name, modelIds, outputs } = await readEngineModelOutputs({ engine: ENGINE, slug: "gpt-sol", limit: 10 });
    expect(name).toBe("GPT Sol");
    expect(modelIds).toEqual(["gpt-sol-2", "gpt-sol-1"]);
    expect(outputs.map((o) => [o.medium, o.subject])).toEqual([
      ["threads", "topic"],
      ["email", "new"],
      ["whatsapp", null],
      ["email", "old"],
    ]);
    expect(outputs[1]).toEqual({
      generationId: expect.any(String), createdAt: "2026-11-12T10:00:00.000Z", medium: "email", promptType: TYPE,
      templateDynasty: { slug: DYNASTY, name: `Email ${tag}`, position: 1 }, model: "gpt-sol-2",
      tokensInput: 1200, tokensOutput: 300, subject: "new", emails: [{ step: 1, bodyText: "new body", daysSinceLastStep: 0 }],
    });
    expect(outputs[0].emails.map((e) => e.bodyText)).toEqual(["Post", "r1"]);
    const words = JSON.stringify(outputs);
    for (const banned of ["workflow", "pipe", "leg", "channel", "play"]) expect(words.toLowerCase()).not.toContain(`"${banned}`);
  });

  it("an Engine with no template dynasty, or an LLM that never wrote for it, answers an empty list", async () => {
    await insertGen(VISIT_TYPE, "gpt-sol-2", "other-engine", new Date("2026-11-14T10:00:00Z"));
    expect((await readEngineModelOutputs({ engine: ENGINE, slug: "gpt-sol", limit: 5 })).outputs).toEqual([]);
    expect((await readEngineModelOutputs({ engine: `nothing_${tag}`, slug: "gpt-sol", limit: 5 })).outputs).toEqual([]);
  });
});
