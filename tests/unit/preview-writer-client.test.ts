import { describe, it, expect, vi, beforeEach } from "vitest";

// The preview's writer is read live (ONE-WRITER-N-MODELS-1116-CG-PREVIEW): the cold email sender the Rating picks in
// the Engine the catalogue states on the cold email pipe (kept, writing through message_written), then the way of
// writing the Rating picks for THAT sender (its tactic template, that dynasty's head). No model is read: the writer's
// run asks its completion.

const mockResolveDynastyHead = vi.fn();
vi.mock("../../src/lib/template-dynasty-query.js", () => ({
  resolveDynastyHead: (...a: unknown[]) => mockResolveDynastyHead(...a),
}));
import { resolvePreviewWriter, __resetPreviewWriterCache } from "../../src/lib/preview-writer-client.js";
import { clearChannelCatalogueCache } from "../../src/lib/pipe-from-step.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const WAY = { dynasty: "dy_free_offer", scriptId: "w1", version: 1, kept: true, reason: null };
const OLD = { dynasty: "dy_template_writer_full", scriptId: "s1", version: 4, kept: true, reason: null };
const COLD = { dynasty: "dy_cold_email", scriptId: "c1", version: 13, kept: true, reason: null };
const PUSHED = { dynasty: "dy_pushed_email", scriptId: "p1", version: 2, kept: true, reason: null };
const strategyAnswer = (scripts: Array<typeof WAY>) => ({ campaignId: null, strategyId: null, keptDynasties: scripts.filter((s) => s.kept).map((s) => s.dynasty), scripts });
const COLD_TACTICS = { asks: ["message_written", "llm_completion"] };
const engineScripts = () => ({
  scripts: [
    { dynasty: "dy_cold_email", version: 13, tactics: COLD_TACTICS },
    { dynasty: "dy_pushed_email", version: 2, tactics: { recorded_by: "email-gateway" } },
  ],
});
// features-service's channel catalogue: the cold email pipe states the Engine its cold email scripts make.
const catalogue = (outcome: string | null = "email_sent", toKey = "positive_reply") => ({
  channels: [
    { slug: "sales-cold-email-outreach", channelType: "outbound", stepTransitions: [
      { legKey: "lead_found_to_lead_found", from: { key: "lead_found" }, to: { key: "lead_found" }, outcome: "lead_identified" },
      { legKey: "lead_found_to_conversation", from: { key: "lead_found" }, to: { key: toKey }, outcome },
    ] },
  ],
});
const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "11111111-2222-3333-4444-555555555555", brandId: "brand-1" };

type Over = {
  catalogue?: unknown; catalogueStatus?: number;
  writerStrategy?: unknown; writerStrategyStatus?: number;
  coldStrategy?: unknown; coldStrategyStatus?: number;
  scripts?: unknown; scriptsStatus?: number;
  coldPick?: unknown; coldPickStatus?: number;
  wayPick?: unknown; wayPickStatus?: number;
};

function route(over: Over = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.includes("/public/channels")) return json(over.catalogue ?? catalogue(), over.catalogueStatus ?? 200);
    if (url.includes("/internal/script-strategy")) {
      const outcome = new URL(url).searchParams.get("outcome");
      if (outcome === "message_written") return json(over.writerStrategy ?? strategyAnswer([WAY]), over.writerStrategyStatus ?? 200);
      if (outcome === "llm_completion") throw new Error("the preview never reads the completion strategy: the run picks the model");
      return json(over.coldStrategy ?? strategyAnswer([COLD, PUSHED]), over.coldStrategyStatus ?? 200);
    }
    if (url.includes("/scripts?outcome=")) return json(over.scripts ?? engineScripts(), over.scriptsStatus ?? 200);
    if (url.includes("/internal/engines/llm_completion/pick")) throw new Error("the preview never picks a model: the writer's run does");
    if (url.includes("/internal/engines/message_written/pick")) {
      return json(over.wayPick ?? { outcome: "message_written", dynasty: "dy_free_offer", version: 1, scriptId: "w1", draws: [], tactics: { template: "cold-reply-free-offer-named", asks: ["llm_completion"] } }, over.wayPickStatus ?? 200);
    }
    if (/\/internal\/engines\/[^/]+\/pick/.test(url)) {
      const asked = JSON.parse(init?.body ?? "{}");
      return json(over.coldPick ?? { outcome: "email_sent", dynasty: asked.keptDynasties[0], version: 13, scriptId: "c1", draws: [], tactics: COLD_TACTICS }, over.coldPickStatus ?? 200);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const calls = (re: RegExp) => mockFetch.mock.calls.filter((c) => re.test(String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  __resetPreviewWriterCache();
  clearChannelCatalogueCache();
  mockResolveDynastyHead.mockResolvedValue({ dynasty: {}, template: { type: "yc-cold-email-v3" } });
});

describe("resolvePreviewWriter", () => {
  it("a brand with no campaign and no strategy: the writer the Rating picks for the picked sender, and its template", async () => {
    route();
    const plan = await resolvePreviewWriter(IDENTITY);
    expect(plan).toEqual({
      emailScript: { engine: "email_sent", dynasty: "dy_cold_email", version: 13 },
      writerScript: { dynasty: "dy_free_offer", version: 1 },
      templateDynastySlug: "cold-reply-free-offer-named",
      promptType: "yc-cold-email-v3",
    });
    for (const c of calls(/\/internal\/script-strategy/)) {
      expect(String(c[0])).not.toContain("campaignId");
      expect(String(c[0])).not.toContain("strategyId");
    }
    expect(mockResolveDynastyHead).toHaveBeenCalledWith("cold-reply-free-offer-named");
  });

  it("never picks a model or runs dy_template_writer_full: no completion pick, no side template / LLM / workflow pick", async () => {
    route({ writerStrategy: strategyAnswer([WAY, OLD]) });
    const plan = await resolvePreviewWriter(IDENTITY);
    expect(plan.writerScript.dynasty).toBe("dy_free_offer");
    expect(plan).not.toHaveProperty("model");
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /llm_completion|-pick\?|leg-workflow-ranking|leg-writer-ranking|writer-pick|catalogue\/plays|\/workflows/.test(u))).toBe(false);
    // The only message_written pick is the way of writing asked by the sender (never a pick on the old writer's materials).
    const picks = calls(/\/internal\/engines\/message_written\/pick/).map((c) => JSON.parse(c[1].body));
    expect(picks).toEqual([{ keptDynasties: ["dy_free_offer", "dy_template_writer_full"], servable: ["generation_request"], askedBy: "email_sent/dy_cold_email" }]);
  });

  it("the sender pick runs among the kept scripts that write through message_written, handing nothing", async () => {
    route();
    await resolvePreviewWriter(IDENTITY);
    const [pick] = calls(/\/internal\/engines\/email_sent\/pick/);
    expect(JSON.parse(pick[1].body)).toEqual({ keptDynasties: ["dy_cold_email"], servable: [] });
    const [list] = calls(/\/scripts\?outcome=email_sent/);
    expect(list[1].headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": IDENTITY.runId });
  });

  it("the cold email Engine is the one the catalogue states (its `to` step when it states no outcome)", async () => {
    route({ catalogue: catalogue(null, "positive_reply") });
    await resolvePreviewWriter(IDENTITY);
    expect(calls(/\/internal\/engines\/positive_reply\/pick/)).toHaveLength(1);
    expect(calls(/script-strategy\?outcome=positive_reply/)).toHaveLength(1);
  });

  it("the catalogue unreadable, or stating no cold email pipe = 502, nothing written", async () => {
    route({ catalogueStatus: 503, catalogue: { error: "down" } });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 502 });
    clearChannelCatalogueCache();
    route({ catalogue: { channels: [] } });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 502 });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("with a strategyId: both Engines' scripts are asked under it", async () => {
    route();
    await resolvePreviewWriter(IDENTITY, "named-emails-only");
    const strategies = calls(/\/internal\/script-strategy/);
    expect(strategies).toHaveLength(2);
    expect(strategies.every((c) => String(c[0]).includes("strategyId=named-emails-only"))).toBe(true);
  });

  it("an unknown strategy = 400 UNKNOWN_STRATEGY", async () => {
    route({ coldStrategy: { error: "no strategy nope" }, coldStrategyStatus: 404 });
    await expect(resolvePreviewWriter(IDENTITY, "nope")).rejects.toMatchObject({ status: 400, code: "UNKNOWN_STRATEGY" });
  });

  it("a strategy keeping no writer = 422 NO_SCRIPT_KEPT, never another strategy's script", async () => {
    route({ writerStrategy: strategyAnswer([{ ...WAY, kept: false, reason: "excluded by Blind angle" }]) });
    await expect(resolvePreviewWriter(IDENTITY, "blind-emails-only")).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("no kept sender writes through message_written = 422 NO_SCRIPT_KEPT, no pick asked", async () => {
    route({ coldStrategy: strategyAnswer([PUSHED]) });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    expect(calls(/\/internal\/engines\/email_sent\/pick/)).toHaveLength(0);
  });

  it("the Rating finding no sender or no writer it can run = 422 NO_SCRIPT_KEPT", async () => {
    route({ coldPick: { code: "no_runnable_script" }, coldPickStatus: 404 });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    __resetPreviewWriterCache();
    route({ wayPick: { code: "no_runnable_script" }, wayPickStatus: 404 });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
  });

  it("the picked writer stating no template = a named refusal, never a default", async () => {
    route({ wayPick: { dynasty: "dy_free_offer", version: 1, tactics: { asks: ["llm_completion"] } } });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "SCRIPT_STATES_NO_TEMPLATE" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("a pick answering without the script's tactics = 502, never a default", async () => {
    route({ wayPick: { dynasty: "dy_free_offer", version: 1 } });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 502 });
  });

  it("workflow-service's scripts list unreadable = 502", async () => {
    route({ scripts: { error: "boom" }, scriptsStatus: 500 });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 502 });
  });

  it("a stated template dynasty with no head = 503 WRITER_PICK_UNAVAILABLE", async () => {
    const { TemplateDynastyError } = await import("../../src/lib/template-dynasties.js");
    route();
    mockResolveDynastyHead.mockRejectedValue(new TemplateDynastyError(404, "DYNASTY_NOT_FOUND", "no dynasty"));
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 503, code: "WRITER_PICK_UNAVAILABLE" });
  });

  it("caches both picks a few minutes per strategy; the dynasty head is read per preview", async () => {
    route();
    await resolvePreviewWriter(IDENTITY);
    await resolvePreviewWriter({ ...IDENTITY, runId: "run-2" });
    expect(calls(/script-strategy/)).toHaveLength(2);
    expect(calls(/\/internal\/engines\//)).toHaveLength(2);
    expect(calls(/\/scripts\?outcome=/)).toHaveLength(1);
    expect(mockResolveDynastyHead).toHaveBeenCalledTimes(2);
    await resolvePreviewWriter(IDENTITY, "named-emails-only");
    expect(calls(/script-strategy/)).toHaveLength(4);
  });
});
