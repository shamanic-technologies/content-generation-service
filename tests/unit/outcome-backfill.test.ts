import { describe, it, expect } from "vitest";
import { decideBackfill, packBatches, isRetiredFeature, type BackfillRun, type BackfillRow } from "../../src/lib/outcome-backfill.js";

// COST-BACKFILL-1023-CONTENTGEN: where a past email's declaration goes, read from the run tree.
// Shape of a pre-P1 workflow run (measured in prod, 2026-08-10): lead-serve, then chat-service
// `complete` (the completion that wrote the email, cost on it), then our cost-less generation run.
const PARENT = "wf-1";
const run = (id: string, serviceName: string, taskName: string, startedAt: string, costs: BackfillRun["costs"] = []): BackfillRun => ({
  id,
  parentRunId: PARENT,
  serviceName,
  taskName,
  startedAt,
  costs,
});
const completion = (id: string, at: string, tin: number, tout: number) =>
  run(id, "chat-service", "complete", at, [
    { costName: "google-pro-3.1-tokens-input", quantity: tin, totalCostInUsdCents: "1.0", status: "actual" },
    { costName: "google-pro-3.1-tokens-output", quantity: tout, totalCostInUsdCents: "0.5", status: "actual" },
    { costName: "google-pro-3.1-tokens-input", quantity: 6200, totalCostInUsdCents: "0.8", status: "cancelled" },
    { costName: "google-pro-3.1-tokens-output", quantity: 8000, totalCostInUsdCents: "2.0", status: "cancelled" },
  ]);
const gen = run("gen-1", "content-generation-service", "single-generation", "2026-08-10T00:00:18Z");
const row: BackfillRow = { id: "row-1", leadId: "lead-1", featureSlug: "sales-cold-email-outreach", variables: {}, tokensInput: 8041, tokensOutput: 239 };
const declaration = {
  produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
  consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
};

describe("decideBackfill", () => {
  const serve = run("serve-1", "lead-service", "lead-serve", "2026-08-10T00:00:05Z");
  const chat = completion("chat-1", "2026-08-10T00:00:08Z", 8041, 239);
  const send = run("send-1", "instantly-service", "email-send-step-1", "2026-08-10T00:00:25Z", [
    { costName: "instantly-account-email-sent", quantity: 1, totalCostInUsdCents: "3", status: "actual" },
  ]);

  it("declares on the completion run whose actual tokens equal the stored ones (cancelled holds ignored)", () => {
    expect(decideBackfill(row, gen, [serve, chat, gen, send])).toEqual({
      kind: "declare",
      runId: "chat-1",
      cents: 1.5,
      declaration,
      via: "completion_run",
    });
  });

  it("cached and cache-write prompt tokens count as input (stored tokensInput is the whole prompt)", () => {
    const cached = run("chat-c", "chat-service", "complete", "2026-08-10T00:00:08Z", [
      { costName: "anthropic-haiku-5.5-tokens-input", quantity: 11290, totalCostInUsdCents: "1", status: "actual" },
      { costName: "anthropic-haiku-5.5-tokens-cached-input", quantity: 1000, totalCostInUsdCents: "0.1", status: "actual" },
      { costName: "anthropic-haiku-5.5-tokens-cache-write-5m", quantity: 231, totalCostInUsdCents: "0.1", status: "actual" },
      { costName: "anthropic-haiku-5.5-tokens-output", quantity: 1878, totalCostInUsdCents: "1", status: "actual" },
    ]);
    expect(decideBackfill({ ...row, tokensInput: 12521, tokensOutput: 1878 }, gen, [cached, gen])).toMatchObject({ kind: "declare", runId: "chat-c" });
  });

  it("tokens that differ: unreadable, never declared", () => {
    const d = decideBackfill({ ...row, tokensInput: 8040 }, gen, [serve, chat, gen]);
    expect(d.kind).toBe("unreadable");
    expect(d.cents).toBe(1.5);
  });

  it("a completion started after our run (a later step's LLM call) is not ours", () => {
    const later = completion("chat-2", "2026-08-10T00:00:30Z", 8041, 239);
    expect(decideBackfill(row, gen, [serve, gen, later])).toMatchObject({ kind: "unreadable", reason: "no completion run found beside the generation run" });
  });

  it("a completion before an EARLIER generation run under the same parent belongs to that one", () => {
    const earlierGen = run("gen-0", "content-generation-service", "single-generation", "2026-08-10T00:00:10Z");
    expect(decideBackfill(row, gen, [chat, earlierGen, gen])).toMatchObject({ kind: "unreadable" });
  });

  it("two completions (a regenerated answer): unreadable, stated with both runs' spend", () => {
    const retry = completion("chat-0", "2026-08-10T00:00:07Z", 8041, 239);
    expect(decideBackfill(row, gen, [retry, chat, gen])).toMatchObject({ kind: "unreadable", cents: 3 });
  });

  it("Feb-Mar 2026: the service paid Anthropic on its own run, the declaration goes there", () => {
    const own = { ...gen, costs: [{ costName: "anthropic-sonnet-4.6-tokens-input", quantity: 3000, totalCostInUsdCents: "0.9", status: "actual" }] };
    expect(decideBackfill(row, own, [serve, own])).toMatchObject({ kind: "declare", runId: "gen-1", via: "own_run", cents: 0.9 });
  });

  it("no lead id: unreadable (never an invented subject); retired product: skipped", () => {
    expect(decideBackfill({ ...row, leadId: null }, gen, [chat, gen])).toMatchObject({ kind: "unreadable", reason: "no lead id stored on the email" });
    expect(decideBackfill({ ...row, featureSlug: "pr-cold-email-outreach" }, gen, [chat, gen])).toMatchObject({ kind: "skipped" });
    expect(isRetiredFeature("sales-cold-email-outreach")).toBe(false);
  });

  it("company checks read: company_researched consumed too, as P1 declares", () => {
    const d = decideBackfill({ ...row, variables: { leadQualification: { domain: "acme.com", checks: [{}] } } }, gen, [chat, gen]);
    expect(d.kind === "declare" && d.declaration.consumed.map((c) => c.outcomeKey)).toEqual(["lead_found", "company_researched"]);
  });
});

describe("packBatches", () => {
  const entry = (i: number, consumed = 1) => ({
    runId: `r-${i}`,
    occurredAt: "run_started_at" as const,
    produced: [declaration.produced[0]],
    consumed: Array.from({ length: consumed }, () => declaration.consumed[0]),
  });

  it("never exceeds the door's run or occurrence cap", () => {
    const batches = packBatches(Array.from({ length: 1201 }, (_, i) => entry(i, i % 2 ? 2 : 1)));
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(500);
      expect(b.reduce((s, e) => s + e.produced.length + e.consumed.length, 0)).toBeLessThanOrEqual(1000);
    }
    expect(batches.flat()).toHaveLength(1201);
  });
});
