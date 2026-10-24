import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { actualOutputTokens, matchCompletionRuns, type TreeRun } from "../../src/lib/completion-runs.js";

const out = (q: number, status = "actual") => ({ costName: "openai-gpt-5.6-terra-tokens-output", quantity: `${q}.000000`, status });
const inp = (q: number) => ({ costName: "openai-gpt-5.6-terra-tokens-input", quantity: q, status: "actual" });
const complete = (id: string, parentRunId: string, costs: TreeRun["costs"]): TreeRun => ({ id, parentRunId, serviceName: "chat-service", taskName: "complete", costs });
const gen = (over: Partial<TreeRun> = {}): TreeRun => ({ id: "gen", parentRunId: "wf", serviceName: "content-generation", taskName: "single-generation", costs: [], ...over });

describe("actualOutputTokens", () => {
  it("counts actual output rows only, never the provisioned/cancelled hold", () => {
    expect(actualOutputTokens({ costs: [out(8000, "cancelled"), out(184), inp(6400), out(5, "provisioned")] })).toBe(184);
  });
});

describe("matchCompletionRuns", () => {
  it("since P1: the completion child of our run", () => {
    const m = matchCompletionRuns({ tokensOutput: 184, generationRun: gen(), children: [complete("c1", "gen", [out(8000, "cancelled"), out(184)])] });
    expect(m).toEqual({ kind: "matched", runIds: ["c1"], via: "child" });
  });

  it("a regenerated answer: both children, their tokens add up", () => {
    const m = matchCompletionRuns({ tokensOutput: 300, generationRun: gen(), children: [complete("c1", "gen", [out(100)]), complete("c2", "gen", [out(200)])] });
    expect(m).toEqual({ kind: "matched", runIds: ["c1", "c2"], via: "child" });
  });

  it("children that do not add up are a stated reason, never a guess", () => {
    const m = matchCompletionRuns({ tokensOutput: 300, generationRun: gen(), children: [complete("c1", "gen", [out(100)])] });
    expect(m.kind).toBe("unmatched");
    expect((m as { reason: string }).reason).toMatch(/billed 100 output tokens, the generation recorded 300/);
  });

  it("Feb-Mar 2026: our own run paid the vendor", () => {
    const m = matchCompletionRuns({ tokensOutput: 50, generationRun: gen({ costs: [out(50)] }), children: [] });
    expect(m).toEqual({ kind: "matched", runIds: ["gen"], via: "own_run" });
  });

  it("before P1: the one sibling billed exactly the stored output tokens", () => {
    const m = matchCompletionRuns({
      tokensOutput: 412,
      generationRun: gen(),
      children: [],
      siblings: [complete("brand-intel", "wf", [out(90)]), complete("writer", "wf", [out(412)])],
    });
    expect(m).toEqual({ kind: "matched", runIds: ["writer"], via: "sibling" });
  });

  it("two siblings billed the same tokens: cannot tell", () => {
    const m = matchCompletionRuns({ tokensOutput: 412, generationRun: gen(), children: [], siblings: [complete("a", "wf", [out(412)]), complete("b", "wf", [out(412)])] });
    expect(m).toEqual({ kind: "unmatched", reason: "2 completions beside our run were billed exactly 412 output tokens: cannot tell which wrote it" });
  });

  it("no sibling matches, no parent, no tokens recorded: stated reasons", () => {
    expect(matchCompletionRuns({ tokensOutput: 1, generationRun: gen(), children: [], siblings: [complete("a", "wf", [out(2)])] }).kind).toBe("unmatched");
    expect(matchCompletionRuns({ tokensOutput: 1, generationRun: gen({ parentRunId: null }), children: [] })).toEqual({
      kind: "unmatched",
      reason: "our run has no parent and no completion under it",
    });
    expect(matchCompletionRuns({ tokensOutput: null, generationRun: gen(), children: [] })).toEqual({
      kind: "unmatched",
      reason: "no output token count recorded on the generation",
    });
  });
});

describe("matchOrgRows (runs-service reads)", () => {
  const GEN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const GEN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const WF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads our runs, lists the parent's completions only when needed, and states missing runs", async () => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/runs/batch")) {
        const ids = JSON.parse(String(init.body)).runIds as string[];
        if (ids.includes(GEN_A)) {
          return json({
            runs: [
              { ...gen({ id: GEN_A, parentRunId: null }), descendantRuns: [complete("c-new", GEN_A, [out(77)])] },
              { ...gen({ id: GEN_B, parentRunId: WF }), descendantRuns: [] },
            ],
          });
        }
        return json({ runs: [complete("s1", WF, [out(10)]), complete("s2", WF, [out(20)])] });
      }
      expect(u).toContain(`parentRunId=${WF}`);
      expect(u).toContain("taskName=complete");
      return json({ runs: [{ id: "s1" }, { id: "s2" }] });
    });
    const { matchOrgRows } = await import("../../src/lib/completion-run-sweep.js");
    const m = await matchOrgRows("org-1", [
      { id: "r1", org_id: "org-1", generation_run_id: GEN_A, tokens_output: 77 },
      { id: "r2", org_id: "org-1", generation_run_id: GEN_B, tokens_output: 20 },
      { id: "r3", org_id: "org-1", generation_run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", tokens_output: 5 },
      { id: "r4", org_id: "org-1", generation_run_id: null, tokens_output: 5 },
    ]);
    expect(m.get("r1")).toEqual({ kind: "matched", runIds: ["c-new"], via: "child" });
    expect(m.get("r2")).toEqual({ kind: "matched", runIds: ["s2"], via: "sibling" });
    expect(m.get("r3")).toEqual({ kind: "unmatched", reason: "our run is not readable under the generation's org" });
    expect(m.get("r4")).toEqual({ kind: "unmatched", reason: "no run recorded for the generation" });
    expect(fetchMock.mock.calls[0][1].headers["x-org-id"]).toBe("org-1");
  });

  it("a runs-service 5xx throws, so the rows stay unmatched for the next tick", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    const { matchOrgRows, RunsReadError } = await import("../../src/lib/completion-run-sweep.js");
    await expect(matchOrgRows("org-1", [{ id: "r1", org_id: "org-1", generation_run_id: GEN_A, tokens_output: 1 }])).rejects.toBeInstanceOf(RunsReadError);
  });
});
