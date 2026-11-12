import { describe, it, expect, vi, beforeEach } from "vitest";

// The preview's writer is read live (PREVIEW-EMAIL-503-1111): features-service's scripts for the email Engine with NO
// campaign, workflow-service's Rating pick among them, the GTM Factory Rating's template + LLM picks for the Engine's
// writing call (LLM-RATING-PER-ENGINE-1112, on the preview's run), the picked dynasty's head. No workflow, play, leg
// ranking of workflows nor per-channel writer ranking is read.

const mockResolveDynastyHead = vi.fn();
vi.mock("../../src/lib/template-dynasty-query.js", () => ({
  resolveDynastyHead: (...a: unknown[]) => mockResolveDynastyHead(...a),
}));
import { resolvePreviewWriter, __resetPreviewWriterCache } from "../../src/lib/preview-writer-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const SCRIPT = { dynasty: "dy_template_writer_full", scriptId: "s1", version: 4, kept: true, reason: null };
const strategyAnswer = (scripts = [SCRIPT]) => ({ campaignId: null, outcome: "message_written", strategyId: null, keptDynasties: scripts.filter((s) => s.kept).map((s) => s.dynasty), scripts });
const templatePick = { outcome: "message_written", place: "writer", template: { templateDynastySlug: "cold-reply-three-line-reply-named", name: "Three line", head: "t-9" }, candidates: [], evidenceComputedAt: null, evidenceUnavailableReason: null };
const llmPick = { outcome: "message_written", place: "writer", llm: { llmDynastySlug: "gemini-flash-lite", name: "Gemini Flash Lite", provider: "google", model: "gemini-flash-lite" }, candidates: [], evidenceComputedAt: null, evidenceUnavailableReason: null };
const RUN = "11111111-2222-3333-4444-555555555555";

function route(over: { strategy?: unknown; strategyStatus?: number; pick?: unknown; pickStatus?: number; tpl?: unknown; tplStatus?: number; llm?: unknown; llmStatus?: number } = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.includes("/internal/script-strategy")) return json(over.strategy ?? strategyAnswer(), over.strategyStatus ?? 200);
    if (url.includes("/internal/engines/message_written/pick")) {
      const asked = JSON.parse(init?.body ?? "{}");
      return json(over.pick ?? { outcome: "message_written", dynasty: asked.keptDynasties[0], version: 4, scriptId: "s1", draws: [] }, over.pickStatus ?? 200);
    }
    if (url.includes("/internal/template-pick")) return json(over.tpl ?? templatePick, over.tplStatus ?? 200);
    if (url.includes("/internal/llm-pick")) return json(over.llm ?? llmPick, over.llmStatus ?? 200);
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPreviewWriterCache();
  mockResolveDynastyHead.mockResolvedValue({ dynasty: {}, template: { type: "yc-cold-email-v3" } });
});

describe("resolvePreviewWriter", () => {
  it("a brand with no campaign and no strategy: the Engine's kept script, the picked template head and LLM", async () => {
    route();
    const plan = await resolvePreviewWriter(RUN);
    expect(plan).toEqual({ script: { dynasty: "dy_template_writer_full", version: 4 }, templateDynastySlug: "cold-reply-three-line-reply-named", promptType: "yc-cold-email-v3", model: "gemini-flash-lite" });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    const strategyUrl = urls.find((u) => u.includes("/internal/script-strategy"))!;
    expect(strategyUrl).toContain("outcome=message_written");
    expect(strategyUrl).not.toContain("campaignId");
    expect(strategyUrl).not.toContain("strategyId");
    // No workflow, play, workflow ranking nor per-channel writer ranking is read any more.
    expect(urls.some((u) => /leg-workflow-ranking|leg-writer-ranking|writer-pick|catalogue\/plays|\/workflows/.test(u))).toBe(false);
    expect(mockResolveDynastyHead).toHaveBeenCalledWith("cold-reply-three-line-reply-named");
  });

  it("with a strategyId: asks the scripts and the writer pick under it", async () => {
    route();
    await resolvePreviewWriter(RUN, "named-emails-only");
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("features") || !u.includes("/pick")).every((u) => u.includes("strategyId=named-emails-only"))).toBe(true);
  });

  it("an unknown strategy = 400 UNKNOWN_STRATEGY", async () => {
    route({ strategy: { error: "no strategy nope", reason: "strategy_not_found" }, strategyStatus: 404 });
    await expect(resolvePreviewWriter(RUN, "nope")).rejects.toMatchObject({ status: 400, code: "UNKNOWN_STRATEGY" });
  });

  it("a strategy that keeps no script = 422 NO_SCRIPT_KEPT, never another strategy's script", async () => {
    route({ strategy: strategyAnswer([{ ...SCRIPT, kept: false, reason: "excluded by Blind angle" }]) });
    await expect(resolvePreviewWriter(RUN, "blind-emails-only")).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("the Rating picks among the kept scripts (workflow-service), on the preview's materials: never picked here", async () => {
    route({ strategy: strategyAnswer([SCRIPT, { ...SCRIPT, dynasty: "dy_other", scriptId: "s2" }]), pick: { outcome: "message_written", dynasty: "dy_other", version: 2, scriptId: "s2", draws: [] } });
    const plan = await resolvePreviewWriter(RUN);
    expect(plan.script).toEqual({ dynasty: "dy_other", version: 2 });
    const pickCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("/pick"))!;
    expect(JSON.parse(pickCall[1].body)).toEqual({ keptDynasties: ["dy_template_writer_full", "dy_other"], servable: ["lead_identified", "brand_context", "template_written"] });
  });

  it("the Rating finding nothing it can run = 422 NO_SCRIPT_KEPT", async () => {
    route({ pick: { code: "no_runnable_script", error: "no kept dynasty runs on these materials" }, pickStatus: 404 });
    await expect(resolvePreviewWriter(RUN)).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
  });

  it("features-service unreadable = 502, nothing guessed", async () => {
    route({ strategy: { error: "boom" }, strategyStatus: 502 });
    await expect(resolvePreviewWriter(RUN)).rejects.toMatchObject({ status: 502 });
  });

  it("caches the script a few minutes per strategy, never the template + LLM picks (one decision per preview)", async () => {
    route();
    await resolvePreviewWriter(RUN);
    await resolvePreviewWriter("run-2");
    const count = (re: RegExp) => mockFetch.mock.calls.filter((c) => re.test(String(c[0]))).length;
    expect(count(/script-strategy/)).toBe(1);
    expect(count(/\/internal\/engines\//)).toBe(1);
    expect(count(/template-pick/)).toBe(2);
    expect(count(/llm-pick/)).toBe(2);
    await resolvePreviewWriter(RUN, "named-emails-only");
    expect(count(/script-strategy/)).toBe(2);
  });

  it("asks the Rating for the Engine's writing call, with the preview's run as x-run-id", async () => {
    route();
    await resolvePreviewWriter(RUN);
    for (const kind of ["template-pick", "llm-pick"]) {
      const call = mockFetch.mock.calls.find((c) => String(c[0]).includes(`/internal/${kind}?`))!;
      const url = new URL(String(call[0]));
      expect(url.searchParams.get("outcome")).toBe("message_written");
      expect(url.searchParams.get("place")).toBe("writer");
      expect(url.searchParams.get("campaignId")).toBeNull();
      expect(url.searchParams.get("strategyId")).toBeNull();
      expect(call[1].headers["x-run-id"]).toBe(RUN);
    }
  });

  it("the Rating's template pick has nothing for the Engine (422) = NO_TEMPLATE_FOR_ENGINE, nothing written", async () => {
    route({ tpl: { error: "no active template dynasty", reason: "no_template_for_engine" }, tplStatus: 422 });
    await expect(resolvePreviewWriter(RUN)).rejects.toMatchObject({ status: 422, code: "NO_TEMPLATE_FOR_ENGINE" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("no LLM in the Engine's universe (422) = NO_LLM_IN_ENGINE_UNIVERSE, nothing written", async () => {
    route({ llm: { error: "no LLM", reason: "no_llm_in_engine_universe" }, llmStatus: 422 });
    await expect(resolvePreviewWriter(RUN)).rejects.toMatchObject({ status: 422, code: "NO_LLM_IN_ENGINE_UNIVERSE" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("a strategy the Rating does not know (404) = 400 UNKNOWN_STRATEGY", async () => {
    route({ llm: { error: "no strategy nope", reason: "strategy_not_found" }, llmStatus: 404 });
    await expect(resolvePreviewWriter(RUN, "nope")).rejects.toMatchObject({ status: 400, code: "UNKNOWN_STRATEGY" });
  });

  it("a pick that fails otherwise = 502, never a fallback writer", async () => {
    route({ tpl: { error: "boom", reason: "template_rating_unreadable" }, tplStatus: 502 });
    await expect(resolvePreviewWriter(RUN)).rejects.toMatchObject({ status: 502 });
  });
});
