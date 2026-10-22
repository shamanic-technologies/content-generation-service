import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

const resolveWorkflowDynastySlugs = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/dynasty-client.js", () => ({ resolveWorkflowDynastySlugs }));

const { db } = await import("../../src/db/index.js");
const { emailGenerations, prompts, templateDynasties, templateDynastyVersions } = await import("../../src/db/schema.js");
const { readWorkflowDynastyOutputs } = await import("../../src/lib/workflow-dynasty-outputs.js");
const { closeDb, randomId } = await import("../helpers/test-db.js");

const tag = randomId().slice(0, 8);
const TYPE = `wf-outputs-tpl-${tag}-v1`;
const LOOSE_TYPE = `wf-outputs-loose-${tag}`;
const DYNASTY = `wf-outputs-dynasty-${tag}`;
const WF_V1 = `wf-outputs-${tag}`;
const WF_V2 = `wf-outputs-${tag}-v2`;
const OTHER_WF = `wf-outputs-other-${tag}`;

const cleanup = async () => {
  await db.delete(emailGenerations).where(inArray(emailGenerations.workflowSlug, [WF_V1, WF_V2, OTHER_WF]));
  await db.delete(templateDynastyVersions).where(inArray(templateDynastyVersions.dynastySlug, [DYNASTY]));
  await db.delete(templateDynasties).where(inArray(templateDynasties.slug, [DYNASTY]));
  await db.delete(prompts).where(inArray(prompts.type, [TYPE, LOOSE_TYPE]));
};

async function insertGen(workflowSlug: string, promptType: string, model: string, subject: string, createdAt: Date) {
  await db.insert(emailGenerations).values({
    orgId: randomId(),
    runId: `run-${subject}`,
    leadId: randomId(),
    campaignId: randomId(),
    brandIds: [randomId()],
    promptType,
    model,
    workflowSlug,
    subject,
    sequence: [
      { step: 1, bodyText: `${subject} body 1`, bodyHtml: "<p>x</p>", daysSinceLastStep: 0 },
      { step: 2, bodyText: `${subject} body 2`, bodyHtml: "<p>y</p>", daysSinceLastStep: 3 },
    ],
    createdAt,
  });
}

describe("readWorkflowDynastyOutputs", () => {
  beforeEach(async () => {
    await cleanup();
    resolveWorkflowDynastySlugs.mockReset();
    await db.insert(prompts).values([
      { type: TYPE, prompt: "Hi {{name}}", variables: [{ name: "name", description: "n" }] },
      { type: LOOSE_TYPE, prompt: "Hey {{name}}", variables: [{ name: "name", description: "n" }] },
    ]);
    await db.insert(templateDynasties).values({
      slug: DYNASTY, name: `Short question ${tag}`, description: `desc ${tag}`, signature: `sig ${tag}`,
      identity: "named", featureSlug: "sales-cold-email-outreach", legKey: `leg-${tag}`,
    });
    await db.insert(templateDynastyVersions).values({ dynastySlug: DYNASTY, promptType: TYPE, position: 1 });
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns the dynasty's generations across versions, newest first, with template, model and emails", async () => {
    resolveWorkflowDynastySlugs.mockResolvedValue([WF_V1, WF_V2]);
    await insertGen(WF_V1, TYPE, "gemini-3.1-pro-preview", "old", new Date("2026-10-20T10:00:00Z"));
    await insertGen(WF_V2, LOOSE_TYPE, "claude-sonnet-4-6", "new", new Date("2026-10-22T10:00:00Z"));
    await insertGen(OTHER_WF, TYPE, "x", "other", new Date("2026-10-22T11:00:00Z"));

    const outputs = await readWorkflowDynastyOutputs("wf-outputs", 10);
    expect(outputs.map((o) => o.subject)).toEqual(["new", "old"]);
    expect(outputs[0]).toMatchObject({
      runId: "run-new", workflowSlug: WF_V2, promptType: LOOSE_TYPE, templateDynasty: null, model: "claude-sonnet-4-6",
    });
    expect(outputs[1]).toMatchObject({
      runId: "run-old", workflowSlug: WF_V1, promptType: TYPE, model: "gemini-3.1-pro-preview",
      templateDynasty: { slug: DYNASTY, name: `Short question ${tag}`, position: 1 },
      emails: [
        { step: 1, bodyText: "old body 1", daysSinceLastStep: 0 },
        { step: 2, bodyText: "old body 2", daysSinceLastStep: 3 },
      ],
    });
    expect(Object.keys(outputs[1])).not.toEqual(expect.arrayContaining(["orgId", "leadId", "campaignId", "brandIds", "audienceId"]));

    expect(await readWorkflowDynastyOutputs("wf-outputs", 1)).toHaveLength(1);
  });

  it("a dynasty that never ran returns an empty list", async () => {
    resolveWorkflowDynastySlugs.mockResolvedValue([`never-ran-${tag}`]);
    expect(await readWorkflowDynastyOutputs("never-ran", 10)).toEqual([]);
    resolveWorkflowDynastySlugs.mockResolvedValue([]);
    expect(await readWorkflowDynastyOutputs("unknown", 10)).toEqual([]);
  });
});
