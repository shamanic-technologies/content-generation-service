import { describe, it, expect } from "vitest";
import { MAX_WORKFLOW_TREE_RUNS, REVISITED_ERROR_PREFIXES, decideBackfill, ownSubtreeSize, mergeByRun, packBatches, isRetiredFeature, recordedLeadEmail, type BackfillRun, type BackfillRow } from "../../src/lib/outcome-backfill.js";

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
const tree = (n: number, root = "wf-1") =>
  Array.from({ length: n }, (_, i) => ({ id: `${root}-d-${i}`, parentRunId: root, serviceName: "chat-service", taskName: "complete" }));
const workflow = { ...run("wf-1", "campaign-run", "workflow", "execute-workflow"), descendantRuns: tree(5) };
const gen = run("gen-1", "wf-1", "content-generation-service", "single-generation");
const row: BackfillRow = { id: "row-1", leadId: "lead-1", featureSlug: "sales-cold-email-outreach", variables: {}, pipeFromStep: "lead_found" };
const declaration = {
  produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
  consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
};

describe("decideBackfill", () => {
  it("a workflow run whose tree is too big to be emails' is never declared on (its whole spend would land on them)", () => {
    expect(decideBackfill(row, gen, { ...workflow, descendantRuns: tree(MAX_WORKFLOW_TREE_RUNS) })).toMatchObject({ kind: "declare", runId: "wf-1" });
    expect(decideBackfill(row, gen, { ...workflow, descendantRuns: tree(MAX_WORKFLOW_TREE_RUNS + 1) })).toMatchObject({ kind: "unreadable" });
    expect(decideBackfill(row, gen, { ...workflow, descendantRuns: undefined })).toMatchObject({ kind: "unreadable" });
  });

  it("a chain of workflow runs (each starting the next) is declared on: each nested run declares its own email", () => {
    // wf-1 -> wf-2 -> wf-3 ..., each with its own completion: thousands of descendants, a handful of its own.
    const chain = Array.from({ length: 800 }, (_, i) => [
      { id: `wf-${i + 2}`, parentRunId: `wf-${i + 1}`, serviceName: "workflow", taskName: "execute-workflow" },
      ...tree(8, `wf-${i + 2}`),
    ]).flat();
    expect(chain.length).toBeGreaterThan(MAX_WORKFLOW_TREE_RUNS);
    expect(ownSubtreeSize(workflow, chain)).toBe(1);
    expect(decideBackfill(row, gen, { ...workflow, descendantRuns: [...tree(5), ...chain] })).toMatchObject({ kind: "declare", runId: "wf-1" });
    // A huge subtree under a non-workflow child still counts.
    const deep = [{ id: "x", parentRunId: "wf-1", serviceName: "lead-service", taskName: "lead-serve" }, ...tree(MAX_WORKFLOW_TREE_RUNS, "x")];
    expect(decideBackfill(row, gen, { ...workflow, descendantRuns: deep })).toMatchObject({ kind: "unreadable" });
  });

  it("declares on the workflow run that called us: the completion and the brand intel beside us roll into it", () => {
    expect(decideBackfill(row, gen, workflow)).toEqual({ kind: "declare", runId: "wf-1", declaration, via: "workflow_run" });
  });

  it("PIPE-FROM-STEP-1024: a reactive pipe's email consumes the step it starts from, a pipe from nothing consumes no lead occurrence", () => {
    const reactive = decideBackfill({ ...row, pipeFromStep: "conversation" }, gen, workflow);
    expect(reactive).toMatchObject({ kind: "declare" });
    expect(reactive.kind === "declare" && reactive.declaration.consumed).toEqual([{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-1" }]);
    const fromNothing = decideBackfill({ ...row, pipeFromStep: null }, gen, workflow);
    expect(fromNothing.kind === "declare" && fromNothing.declaration.consumed).toEqual([]);
  });

  it("a parent that is not a workflow run (a staff probe, a preview proof) is not declared on", () => {
    expect(decideBackfill(row, gen, run("wf-1", null, "content-generation-service", "staff-dry-run-preview-no-send"))).toMatchObject({ kind: "unreadable" });
  });

  it("our run not readable: unreadable with the reason, unless the row is skipped first", () => {
    expect(decideBackfill(row, gen, workflow, "runs-service 500 reading run gen-1")).toEqual({ kind: "unreadable", reason: "runs-service 500 reading run gen-1" });
    expect(decideBackfill({ ...row, leadId: null }, gen, workflow, "x")).toMatchObject({ reason: "no lead id nor address stored on the email" });
  });

  it("parent not readable under the email's org: unreadable", () => {
    expect(decideBackfill(row, gen, undefined)).toMatchObject({ kind: "unreadable", reason: "parent run not readable under the email's org" });
  });

  it("Feb-Mar 2026: the service paid Anthropic on its own run, the declaration goes there", () => {
    const own = run("gen-1", null, "content-generation-service", "single-generation", [
      { costName: "anthropic-sonnet-4.6-tokens-input", quantity: 3000, totalCostInUsdCents: "0.9", status: "actual" },
    ]);
    expect(decideBackfill(row, own, undefined)).toMatchObject({ kind: "declare", runId: "gen-1", via: "own_run" });
    expect(decideBackfill(row, { ...own, costs: [] }, undefined)).toMatchObject({ kind: "unreadable" });
  });

  it("LEDGER-RESIDUAL-1025: under a campaign's root run, declared on OUR run (never on the root: its whole spend would land on one email)", () => {
    const camp = run("camp-run", null, "campaign-service", "c-1");
    expect(decideBackfill(row, run("gen-1", "camp-run", "content-generation-service", "single-generation"), camp)).toEqual({
      kind: "declare",
      runId: "gen-1",
      declaration,
      via: "own_run_under_campaign",
    });
  });

  it("no lead named: unreadable with why (never an invented subject)", () => {
    expect(decideBackfill({ ...row, leadId: null }, gen, workflow)).toMatchObject({ kind: "unreadable", reason: "no lead id nor address stored on the email" });
    const why = "lead-service names no lead of the org for the stored address";
    expect(decideBackfill({ ...row, leadId: null, unnamedReason: why }, gen, workflow)).toMatchObject({ kind: "unreadable", reason: why });
  });

  it("LEDGER-RESIDUAL-1025: a retired product's email is declared at $0 on OUR run, its spend stays produced none", () => {
    const retired = { ...row, featureSlug: "pr-cold-email-outreach" };
    expect(decideBackfill(retired, gen, workflow)).toEqual({ kind: "declare", runId: "gen-1", declaration, via: "own_run_retired" });
    // Our run holding its spend: declaring there would put the retired spend on the email.
    const spent = { ...gen, costs: [{ costName: "anthropic-x", quantity: 1, totalCostInUsdCents: "0.5", status: "actual" }] };
    expect(decideBackfill(retired, spent, workflow)).toMatchObject({ kind: "unreadable" });
    expect(isRetiredFeature("sales-cold-email-outreach")).toBe(false);
  });

  it("no decision writes a mark the revisit reads again (a replay reads nothing)", () => {
    const reasons = [
      decideBackfill({ ...row, leadId: null }, gen, workflow),
      decideBackfill(row, gen, run("wf-1", null, "content-generation-service", "staff-dry-run-preview-no-send")),
      decideBackfill(row, gen, undefined),
      decideBackfill({ ...row, featureSlug: "pr-x" }, { ...gen, costs: [{ costName: "a", quantity: 1, totalCostInUsdCents: 1 }] }, workflow),
    ].map((d) => (d.kind === "declare" ? "" : `backfill: ${d.reason}`));
    for (const r of reasons) expect(REVISITED_ERROR_PREFIXES.some((p) => r.startsWith(p))).toBe(false);
  });

  it("recordedLeadEmail: the address the request stored, or null", () => {
    expect(recordedLeadEmail({ leadEmail: " Ann@Acme.com " })).toBe("Ann@Acme.com");
    expect(recordedLeadEmail({ leadEmail: "" })).toBeNull();
    expect(recordedLeadEmail({ leadEmail: "n/a" })).toBeNull();
    expect(recordedLeadEmail(null)).toBeNull();
  });

  it("company checked (a yes/no verdict): company_researched consumed too, as P1 declares", () => {
    const d = decideBackfill({ ...row, variables: { leadQualification: { domain: "acme.com", checks: [{ verdict: "yes" }] } } }, gen, workflow);
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
