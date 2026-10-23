import { describe, it, expect } from "vitest";
import { decideBackfill, mergeByRun, packBatches, isRetiredFeature, type BackfillRun, type BackfillRow } from "../../src/lib/outcome-backfill.js";

// COST-BACKFILL-1023-CONTENTGEN: where a past email's declaration goes, read from the run tree.
// Shape of a pre-P1 email (measured in prod, 2026-08-10): workflow-service's execute-workflow run
// holds the lead serve, the chat-service completion that wrote the email (cost on it) and our
// cost-less generation run, all as direct children.
const run = (id: string, parentRunId: string | null, serviceName: string, taskName: string, costs: BackfillRun["costs"] = []): BackfillRun => ({
  id,
  parentRunId,
  serviceName,
  taskName,
  startedAt: "2026-08-10T00:00:18Z",
  costs,
});
const workflow = run("wf-1", "campaign-run", "workflow", "execute-workflow");
const gen = run("gen-1", "wf-1", "content-generation-service", "single-generation");
const row: BackfillRow = { id: "row-1", leadId: "lead-1", featureSlug: "sales-cold-email-outreach", variables: {} };
const declaration = {
  produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
  consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
};

describe("decideBackfill", () => {
  it("declares on the workflow run that called us: the completion and the brand intel beside us roll into it", () => {
    expect(decideBackfill(row, gen, workflow)).toEqual({ kind: "declare", runId: "wf-1", declaration, via: "workflow_run" });
  });

  it("a parent that is not a workflow run (a staff probe, a preview proof) is not declared on", () => {
    expect(decideBackfill(row, gen, run("wf-1", null, "content-generation-service", "staff-dry-run-preview-no-send"))).toMatchObject({ kind: "unreadable" });
  });

  it("our run not readable: unreadable with the reason, unless the row is skipped first", () => {
    expect(decideBackfill(row, gen, workflow, "runs-service 500 reading run gen-1")).toEqual({ kind: "unreadable", reason: "runs-service 500 reading run gen-1" });
    expect(decideBackfill({ ...row, leadId: null }, gen, workflow, "x")).toMatchObject({ reason: "no lead id stored on the email" });
  });

  it("parent not readable under the email's org: unreadable", () => {
    expect(decideBackfill(row, gen, undefined)).toMatchObject({ kind: "unreadable", reason: "parent run not readable under the email's org" });
  });

  it("Feb-Mar 2026: the service paid Anthropic on its own run, the declaration goes there (even under a campaign run)", () => {
    const underCampaign = run("gen-1", "camp-run", "content-generation-service", "single-generation", [
      { costName: "anthropic-sonnet-4.6-tokens-input", quantity: 3000, totalCostInUsdCents: "0.9", status: "actual" },
    ]);
    expect(decideBackfill(row, underCampaign, run("camp-run", null, "campaign-service", "c-1"))).toMatchObject({ kind: "declare", runId: "gen-1", via: "own_run" });
    expect(decideBackfill(row, { ...underCampaign, costs: [] }, run("camp-run", null, "campaign-service", "c-1"))).toMatchObject({ kind: "unreadable" });
    const own = run("gen-1", null, "content-generation-service", "single-generation", [
      { costName: "anthropic-sonnet-4.6-tokens-input", quantity: 3000, totalCostInUsdCents: "0.9", status: "actual" },
    ]);
    expect(decideBackfill(row, own, undefined)).toMatchObject({ kind: "declare", runId: "gen-1", via: "own_run" });
    expect(decideBackfill(row, { ...own, costs: [] }, undefined)).toMatchObject({ kind: "unreadable" });
  });

  it("no lead id: unreadable (never an invented subject); retired product: skipped", () => {
    expect(decideBackfill({ ...row, leadId: null }, gen, workflow)).toMatchObject({ kind: "unreadable", reason: "no lead id stored on the email" });
    expect(decideBackfill({ ...row, featureSlug: "pr-cold-email-outreach" }, gen, workflow)).toMatchObject({ kind: "skipped" });
    expect(isRetiredFeature("sales-cold-email-outreach")).toBe(false);
  });

  it("company checks read: company_researched consumed too, as P1 declares", () => {
    const d = decideBackfill({ ...row, variables: { leadQualification: { domain: "acme.com", checks: [{}] } } }, gen, workflow);
    expect(d.kind === "declare" && d.declaration.consumed.map((c) => c.outcomeKey)).toEqual(["lead_found", "company_researched"]);
  });
});

describe("mergeByRun", () => {
  const forLead = (lead: string) => ({
    produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: lead }],
    consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: lead }],
  });

  it("one entry per run, several emails = several occurrences, the same person twice counts once", () => {
    const merged = mergeByRun([
      { runId: "wf-1", declaration: forLead("a") },
      { runId: "wf-1", declaration: forLead("b") },
      { runId: "wf-1", declaration: forLead("a") },
      { runId: "wf-2", declaration: forLead("c") },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ runId: "wf-1", occurredAt: "run_started_at" });
    expect(merged[0].produced.map((o) => o.subjectId)).toEqual(["a", "b"]);
    expect(merged[0].consumed).toHaveLength(2);
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
