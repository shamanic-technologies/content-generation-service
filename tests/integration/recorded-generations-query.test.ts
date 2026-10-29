import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { decodeCursor } from "../../src/lib/sequence-feed-query.js";
import { readRecordedGenerations } from "../../src/lib/recorded-generations-query.js";
import { findGenerationForLead } from "../../src/lib/lead-generation-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

// FACTORY-P3-RECORD-SYSTEM-PROMPT: the read workflow-service's case recorder pages through.
// Each test writes in its own window far in the past: the CI database is shared with other suites.

const ids: string[] = [];

async function insertGen(opts: { createdAt: Date; recorded: boolean; runId?: string; generationRunId?: string }) {
  const request = {
    message: "Write to Marie.",
    systemPrompt: "Universal rules\nTEST VOICE\nWrite in German.",
    responseSchema: { type: "object" },
    provider: "anthropic",
    model: "claude-sonnet",
  };
  const [row] = await db
    .insert(emailGenerations)
    .values({
      orgId: randomId(),
      runId: opts.runId ?? `run-${randomId()}`,
      generationRunId: opts.generationRunId ?? `gen-run-${randomId()}`,
      leadId: randomId(),
      campaignId: randomId(),
      brandIds: [randomId()],
      featureSlug: "sales-cold-email-outreach",
      workflowSlug: "wf-v3",
      promptType: "cold-email-v75",
      model: "claude-sonnet-4-6",
      variablesRaw: { leadFirstName: "Marie" },
      promptRaw: request.message,
      responseRaw: { json: { subject: "Hallo", emails: [{ body: "Hallo Marie", daysSinceLastStep: 0 }] }, model: "claude-sonnet-4-6" },
      subject: "Hallo",
      sequence: [{ step: 1, bodyText: "Hallo Marie", bodyHtml: "<p>Hallo Marie</p>", daysSinceLastStep: 0 }],
      tokensInput: 900,
      tokensOutput: 120,
      chatRequest: opts.recorded ? request : null,
      chatRequestInputs: opts.recorded
        ? { promptTemplate: "Write to {{leadFirstName}}.", campaignContext: null, language: "German", giveLists: null, instruction: null, clientCommsVoice: "TEST VOICE" }
        : null,
      createdAt: opts.createdAt,
    })
    .returning();
  ids.push(row.id);
  return row;
}

afterAll(async () => {
  if (ids.length) await db.delete(emailGenerations).where(inArray(emailGenerations.id, ids));
  await closeDb();
});

describe("readRecordedGenerations", () => {
  it("pages the recorded generations of a window, in write order, with the full request", async () => {
    const t0 = Date.UTC(2001, 0, 1);
    const a = await insertGen({ createdAt: new Date(t0), recorded: true });
    await insertGen({ createdAt: new Date(t0 + 500), recorded: false }); // written before recording: never served
    const b = await insertGen({ createdAt: new Date(t0 + 1000), recorded: true });
    const c = await insertGen({ createdAt: new Date(t0 + 2000), recorded: true });
    await insertGen({ createdAt: new Date(t0 + 3_600_000), recorded: true }); // outside the window

    const window = { from: new Date(t0).toISOString(), to: new Date(t0 + 60_000).toISOString(), settleSeconds: 0 };
    const p1 = await readRecordedGenerations({ ...window, cursor: null, limit: 2 });
    expect(p1.generations.map((g) => g.generationId)).toEqual([a.id, b.id]);
    expect(p1.hasMore).toBe(true);
    expect(p1.generations[0]).toMatchObject({
      createdAt: new Date(t0).toISOString(),
      runId: a.runId,
      generationRunId: a.generationRunId,
      promptType: "cold-email-v75",
      model: "claude-sonnet-4-6",
      variables: { leadFirstName: "Marie" },
      request: {
        message: "Write to Marie.",
        systemPrompt: "Universal rules\nTEST VOICE\nWrite in German.",
        responseSchema: { type: "object" },
        provider: "anthropic",
        model: "claude-sonnet",
      },
      inputs: { promptTemplate: "Write to {{leadFirstName}}.", language: "German", clientCommsVoice: "TEST VOICE" },
      response: { json: { subject: "Hallo" } },
      output: { subject: "Hallo", sequence: [{ step: 1, bodyText: "Hallo Marie" }] },
    });

    const p2 = await readRecordedGenerations({ ...window, cursor: decodeCursor(p1.nextCursor!), limit: 2 });
    expect(p2.generations.map((g) => g.generationId)).toEqual([c.id]);
    expect(p2.hasMore).toBe(false);

    const p3 = await readRecordedGenerations({ ...window, cursor: decodeCursor(p2.nextCursor!), limit: 2 });
    expect(p3.generations).toEqual([]);
    expect(p3.nextCursor).toBe(p2.nextCursor);
  });

  it("finds a generation by the caller's run or by its own generation run", async () => {
    const t0 = Date.UTC(2002, 0, 1);
    const runId = `run-${randomId()}`;
    const generationRunId = `gen-run-${randomId()}`;
    const g = await insertGen({ createdAt: new Date(t0), recorded: true, runId, generationRunId });
    await insertGen({ createdAt: new Date(t0 + 1000), recorded: true });

    for (const r of [runId, generationRunId]) {
      const page = await readRecordedGenerations({ runId: r, cursor: null, limit: 10, settleSeconds: 0 });
      expect(page.generations.map((x) => x.generationId)).toEqual([g.id]);
    }
  });

  it("holds back a generation younger than the settle window", async () => {
    const runId = `run-${randomId()}`;
    await insertGen({ createdAt: new Date(), recorded: true, runId });
    const held = await readRecordedGenerations({ runId, cursor: null, limit: 10, settleSeconds: 60 });
    expect(held.generations).toEqual([]);
    const now = await readRecordedGenerations({ runId, cursor: null, limit: 10, settleSeconds: 0 });
    expect(now.generations).toHaveLength(1);
  });

  it("is never part of a whole-row read (GET /generations/by-lead keeps its shape)", async () => {
    const g = await insertGen({ createdAt: new Date(Date.UTC(2003, 0, 1)), recorded: true });
    const row = await findGenerationForLead({ orgId: g.orgId, leadId: g.leadId! });
    expect(row?.id).toBe(g.id);
    expect(row).not.toHaveProperty("chatRequest");
    expect(row).not.toHaveProperty("chatRequestInputs");
    expect(row).toHaveProperty("promptRaw");
  });
});
