import { describe, it, expect, vi, beforeEach } from "vitest";

// The preview's writer is read live (PREVIEW-EMAIL-503-1111): features-service's scripts for the email Engine with NO
// campaign, its writer pick, the picked dynasty's head. No workflow, play or leg ranking of workflows is read.

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
const writerRanking = {
  computedAt: "2026-11-11T12:17:35Z",
  templates: { best: { templateDynastySlug: "cold-reply-three-line-reply-named" }, unavailableReason: null },
  llms: { best: { llmDynastySlug: "gemini-flash-lite", aliases: [{ alias: "gemini-flash-lite", status: "active" }] }, unavailableReason: null },
};

function route(over: { strategy?: unknown; strategyStatus?: number } = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/internal/script-strategy")) return json(over.strategy ?? strategyAnswer(), over.strategyStatus ?? 200);
    if (url.includes("/public/stats/leg-writer-ranking")) return json(writerRanking);
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
    const plan = await resolvePreviewWriter();
    expect(plan).toEqual({ script: { dynasty: "dy_template_writer_full", version: 4 }, templateDynastySlug: "cold-reply-three-line-reply-named", promptType: "yc-cold-email-v3", model: "gemini-flash-lite" });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    const strategyUrl = urls.find((u) => u.includes("/internal/script-strategy"))!;
    expect(strategyUrl).toContain("outcome=message_written");
    expect(strategyUrl).not.toContain("campaignId");
    expect(strategyUrl).not.toContain("strategyId");
    // No workflow, play or workflow ranking is read any more.
    expect(urls.some((u) => /leg-workflow-ranking|catalogue\/plays|\/workflows/.test(u))).toBe(false);
    expect(mockResolveDynastyHead).toHaveBeenCalledWith("cold-reply-three-line-reply-named");
  });

  it("with a strategyId: asks the scripts and the writer pick under it", async () => {
    route();
    await resolvePreviewWriter("named-emails-only");
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes("strategyId=named-emails-only"))).toBe(true);
  });

  it("an unknown strategy = 400 UNKNOWN_STRATEGY", async () => {
    route({ strategy: { error: "no strategy nope", reason: "strategy_not_found" }, strategyStatus: 404 });
    await expect(resolvePreviewWriter("nope")).rejects.toMatchObject({ status: 400, code: "UNKNOWN_STRATEGY" });
  });

  it("a strategy that keeps no script = 422 NO_SCRIPT_KEPT, never another strategy's script", async () => {
    route({ strategy: strategyAnswer([{ ...SCRIPT, kept: false, reason: "excluded by Blind angle" }]) });
    await expect(resolvePreviewWriter("blind-emails-only")).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("several kept scripts are the Rating's to choose: refused by name, never picked here", async () => {
    route({ strategy: strategyAnswer([SCRIPT, { ...SCRIPT, dynasty: "dy_other", scriptId: "s2" }]) });
    await expect(resolvePreviewWriter()).rejects.toMatchObject({ status: 503, code: "SCRIPT_PICK_UNAVAILABLE" });
  });

  it("features-service unreadable = 502, nothing guessed", async () => {
    route({ strategy: { error: "boom" }, strategyStatus: 502 });
    await expect(resolvePreviewWriter()).rejects.toMatchObject({ status: 502 });
  });

  it("caches the plan a few minutes per strategy", async () => {
    route();
    await resolvePreviewWriter();
    await resolvePreviewWriter();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await resolvePreviewWriter("named-emails-only");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
