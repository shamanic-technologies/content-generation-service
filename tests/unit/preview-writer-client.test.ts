import { describe, it, expect, vi, beforeEach } from "vitest";

// The preview's writer is read live (PREVIEW-EMAIL-503-1111, SCRIPT-VALUE-RATING-1113): the message_written script the
// strategy keeps (features-service, NO campaign) as workflow-service's Rating picks it; the cold email script the Rating
// picks in the Engine the catalogue states on the cold email pipe (among the kept ones that write through
// message_written), whose tactics name the template + LLM; the stated dynasty's head. No side template / LLM pick.

const mockResolveDynastyHead = vi.fn();
vi.mock("../../src/lib/template-dynasty-query.js", () => ({
  resolveDynastyHead: (...a: unknown[]) => mockResolveDynastyHead(...a),
}));
import { resolvePreviewWriter, __resetPreviewWriterCache } from "../../src/lib/preview-writer-client.js";
import { clearChannelCatalogueCache } from "../../src/lib/pipe-from-step.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const WRITER = { dynasty: "dy_template_writer_full", scriptId: "s1", version: 4, kept: true, reason: null };
const COLD = { dynasty: "dy_cold_email", scriptId: "c1", version: 10, kept: true, reason: null };
const PUSHED = { dynasty: "dy_pushed_email", scriptId: "p1", version: 2, kept: true, reason: null };
const strategyAnswer = (scripts: Array<typeof WRITER>) => ({ campaignId: null, strategyId: null, keptDynasties: scripts.filter((s) => s.kept).map((s) => s.dynasty), scripts });
const COLD_TACTICS = { llm: { name: "Gemini Flash-Lite", model: "gemini-flash-lite", provider: "google" }, asks: ["message_written"], template: "cold-reply-three-line-reply-named" };
const engineScripts = () => ({
  scripts: [
    { dynasty: "dy_cold_email", version: 10, tactics: COLD_TACTICS },
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
  writerPick?: unknown; writerPickStatus?: number;
  coldPick?: unknown; coldPickStatus?: number;
};

function route(over: Over = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.includes("/public/channels")) return json(over.catalogue ?? catalogue(), over.catalogueStatus ?? 200);
    if (url.includes("/internal/script-strategy")) {
      const outcome = new URL(url).searchParams.get("outcome");
      if (outcome === "message_written") return json(over.writerStrategy ?? strategyAnswer([WRITER]), over.writerStrategyStatus ?? 200);
      return json(over.coldStrategy ?? strategyAnswer([COLD, PUSHED]), over.coldStrategyStatus ?? 200);
    }
    if (url.includes("/scripts?outcome=")) return json(over.scripts ?? engineScripts(), over.scriptsStatus ?? 200);
    if (url.includes("/internal/engines/message_written/pick")) {
      const asked = JSON.parse(init?.body ?? "{}");
      return json(over.writerPick ?? { outcome: "message_written", dynasty: asked.keptDynasties[0], version: 4, scriptId: "s1", draws: [], tactics: {} }, over.writerPickStatus ?? 200);
    }
    if (/\/internal\/engines\/[^/]+\/pick/.test(url)) {
      const asked = JSON.parse(init?.body ?? "{}");
      return json(over.coldPick ?? { outcome: "email_sent", dynasty: asked.keptDynasties[0], version: 10, scriptId: "c1", draws: [], tactics: COLD_TACTICS }, over.coldPickStatus ?? 200);
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
  it("a brand with no campaign and no strategy: the writer script, and the template + LLM the picked cold email script states", async () => {
    route();
    const plan = await resolvePreviewWriter(IDENTITY);
    expect(plan).toEqual({
      script: { dynasty: "dy_template_writer_full", version: 4 },
      emailScript: { engine: "email_sent", dynasty: "dy_cold_email", version: 10 },
      templateDynastySlug: "cold-reply-three-line-reply-named",
      promptType: "yc-cold-email-v3",
      model: "gemini-flash-lite",
    });
    for (const c of calls(/\/internal\/script-strategy/)) {
      expect(String(c[0])).not.toContain("campaignId");
      expect(String(c[0])).not.toContain("strategyId");
    }
    expect(mockResolveDynastyHead).toHaveBeenCalledWith("cold-reply-three-line-reply-named");
  });

  it("never asks a side template or LLM pick, nor a workflow / play / writer ranking", async () => {
    route();
    await resolvePreviewWriter(IDENTITY);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /-pick\?|leg-workflow-ranking|leg-writer-ranking|writer-pick|catalogue\/plays|\/workflows/.test(u))).toBe(false);
  });

  it("the cold email pick runs among the kept scripts that write through message_written, handing nothing", async () => {
    route();
    await resolvePreviewWriter(IDENTITY);
    const [pick] = calls(/\/internal\/engines\/email_sent\/pick/);
    expect(JSON.parse(pick[1].body)).toEqual({ keptDynasties: ["dy_cold_email"], servable: [] });
    const [list] = calls(/\/scripts\?outcome=email_sent/);
    expect(list[1].headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": IDENTITY.runId });
    const [writerPick] = calls(/\/internal\/engines\/message_written\/pick/);
    expect(JSON.parse(writerPick[1].body)).toEqual({ keptDynasties: ["dy_template_writer_full"], servable: ["lead_identified", "brand_context", "template_written"] });
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

  it("a strategy keeping no writer script = 422 NO_SCRIPT_KEPT, never another strategy's script", async () => {
    route({ writerStrategy: strategyAnswer([{ ...WRITER, kept: false, reason: "excluded by Blind angle" }]) });
    await expect(resolvePreviewWriter(IDENTITY, "blind-emails-only")).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("no kept cold email script writes through message_written = 422 NO_SCRIPT_KEPT, no pick asked", async () => {
    route({ coldStrategy: strategyAnswer([PUSHED]) });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
    expect(calls(/\/internal\/engines\/email_sent\/pick/)).toHaveLength(0);
  });

  it("the Rating finding nothing it can run = 422 NO_SCRIPT_KEPT", async () => {
    route({ coldPick: { code: "no_runnable_script" }, coldPickStatus: 404 });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
  });

  it("the picked cold email script stating no template or LLM = a named refusal, nothing written", async () => {
    route({ coldPick: { dynasty: "dy_cold_email", version: 10, tactics: { asks: ["message_written"], llm: { model: "glm" } } } });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "SCRIPT_STATES_NO_TEMPLATE" });
    __resetPreviewWriterCache();
    route({ coldPick: { dynasty: "dy_cold_email", version: 10, tactics: { asks: ["message_written"], template: "t" } } });
    await expect(resolvePreviewWriter(IDENTITY)).rejects.toMatchObject({ status: 422, code: "SCRIPT_STATES_NO_LLM" });
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("a pick answering without the script's tactics = 502, never a default", async () => {
    route({ coldPick: { dynasty: "dy_cold_email", version: 10 } });
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
