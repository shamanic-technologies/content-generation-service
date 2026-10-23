import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveDynastyHead = vi.fn();
vi.mock("../../src/lib/template-dynasty-query.js", () => ({
  resolveDynastyHead: (...a: unknown[]) => mockResolveDynastyHead(...a),
}));
import { resolvePreviewWorkflow, __resetPreviewWorkflowCache } from "../../src/lib/preview-workflow-client.js";
import { PreviewWorkflowError } from "../../src/lib/preview-workflow.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1" };

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const ranking = {
  computedAt: "2026-10-06T00:00:00Z",
  rows: [
    { rank: 1, workflowDynastySlug: "landing", selectable: true, isMature: true, basis: "mature", costPerOutcomeUsd: 10, moneyGoesHere: true },
    { rank: 2, workflowDynastySlug: "plain", selectable: true, isMature: true, basis: "mature", costPerOutcomeUsd: 20, moneyGoesHere: false },
  ],
};
const dag = (type: string, model: string, inputMapping: Record<string, string>) => ({
  nodes: [{ id: "email-generate", config: { service: "content-generation", path: "/generate", body: { type, model } }, inputMapping }],
});
const workflows: Record<string, unknown> = {
  landing: { workflows: [{ workflowSlug: "landing-v2", workflowDynastySlug: "landing", dag: dag("cold-email-v39-landing", "pro", { "body.variables.landingPageContent": "$ref:landing-content.output.value" }) }] },
  plain: { workflows: [{ workflowSlug: "plain-v3", workflowDynastySlug: "plain", dag: dag("cold-email-v55", "flash-lite", { "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName" }) }] },
  picked: {
    workflows: [
      {
        workflowSlug: "picked-v5",
        workflowDynastySlug: "picked",
        dag: {
          nodes: [
            {
              id: "email-generate",
              config: { service: "content-generation", path: "/generate", body: {} },
              inputMapping: {
                "body.type": "$ref:template-head.output.template.type",
                "body.model": "$ref:writer-plan.output.model",
                "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
              },
            },
          ],
        },
      },
    ],
  },
};

const writerRanking = (dynasty: string) => ({
  computedAt: "2026-10-23T00:00:00Z",
  templates: { best: { templateDynastySlug: dynasty }, unavailableReason: null },
  llms: { best: { llmDynastySlug: "kimi-k2", aliases: [{ alias: "kimi-k2", status: "active" }] }, unavailableReason: null },
});

const plays: Record<string, unknown> = {
  "sales-cold-email-outreach|lead_found_to_conversation~plain-only": { allowedWorkflowDynastySlugs: ["plain"], bestWorkflowSlug: null },
  "sales-cold-email-outreach|lead_found_to_conversation~blind-emails-only": { allowedWorkflowDynastySlugs: ["picked"], bestWorkflowSlug: "picked" },
};

function route(url: string) {
  if (url.includes("/public/stats/leg-workflow-ranking")) return json({ ...ranking, rows: [...ranking.rows, { rank: 3, workflowDynastySlug: "picked", selectable: true, isMature: false, basis: "flash", costPerOutcomeUsd: null, moneyGoesHere: false }] });
  if (url.includes("/public/stats/leg-writer-ranking")) {
    const strategy = new URL(url).searchParams.get("strategyId");
    return json(writerRanking(strategy === "blind-emails-only" ? "cold-reply-pain-question-blind" : "cold-reply-brand-first-stack-named"));
  }
  if (url.includes("/internal/catalogue/plays/")) {
    const id = decodeURIComponent(url.split("/internal/catalogue/plays/")[1]);
    return plays[id] ? json(plays[id]) : json({ error: "no play", reason: "play_not_found" }, 404);
  }
  const slug = new URL(url).searchParams.get("workflowDynastySlug")!;
  return json(workflows[slug]);
}

beforeEach(() => {
  mockFetch.mockReset();
  __resetPreviewWorkflowCache();
  mockFetch.mockImplementation(async (url: string) => route(url));
  mockResolveDynastyHead.mockReset();
  mockResolveDynastyHead.mockImplementation(async (slug: string) => ({ dynasty: { slug }, template: { type: slug === "cold-reply-pain-question-blind" ? "blind-discovery-email-v4" : "cold-email-v61" } }));
});

describe("resolvePreviewWorkflow", () => {
  it("reads the positive-reply leg ranking of the cold-email feature and skips a best workflow a preview cannot reproduce", async () => {
    const plan = await resolvePreviewWorkflow(IDENTITY);
    expect(plan).toMatchObject({ workflowSlug: "plain-v3", promptType: "cold-email-v55", model: "flash-lite" });
    const rankingUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(rankingUrl.searchParams.get("featureSlug")).toBe("sales-cold-email-outreach");
    expect(rankingUrl.searchParams.get("leg")).toBe("lead_found_to_conversation");
    // workflow-service gets the caller's identity headers.
    expect(mockFetch.mock.calls[1][1].headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" });
  });

  it("caches the choice for a few minutes", async () => {
    await resolvePreviewWorkflow(IDENTITY);
    const calls = mockFetch.mock.calls.length;
    await resolvePreviewWorkflow(IDENTITY);
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it("fails loud when features-service cannot answer, or no mature workflow is reproducible", async () => {
    mockFetch.mockImplementation(async () => json({ error: "boom" }, 500));
    await expect(resolvePreviewWorkflow(IDENTITY)).rejects.toMatchObject({ status: 502 });

    __resetPreviewWorkflowCache();
    mockFetch.mockImplementation(async (url: string) => (url.includes("ranking") ? json({ computedAt: null, rows: [] }) : route(url)));
    await expect(resolvePreviewWorkflow(IDENTITY)).rejects.toMatchObject({ status: 503 });

    __resetPreviewWorkflowCache();
    mockFetch.mockImplementation(async (url: string) => (url.includes("ranking") ? json({ ...ranking, rows: [ranking.rows[0]] }) : route(url)));
    await expect(resolvePreviewWorkflow(IDENTITY)).rejects.toBeInstanceOf(PreviewWorkflowError);
  });

  it("fails loud when workflow-service does not list exactly one executable version", async () => {
    mockFetch.mockImplementation(async (url: string) => (url.includes("ranking") ? json(ranking) : json({ workflows: [] })));
    await expect(resolvePreviewWorkflow(IDENTITY)).rejects.toMatchObject({ status: 502 });
  });

  it("with a strategy, writes with a workflow that play allows, and caches per strategy", async () => {
    const plan = await resolvePreviewWorkflow(IDENTITY, "plain-only");
    expect(plan.workflowSlug).toBe("plain-v3");
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/internal/catalogue/plays/sales-cold-email-outreach%7Clead_found_to_conversation~plain-only"))).toBe(true);
    const calls = mockFetch.mock.calls.length;
    await resolvePreviewWorkflow(IDENTITY, "plain-only");
    expect(mockFetch.mock.calls.length).toBe(calls);
    // The default choice is its own cache entry.
    await resolvePreviewWorkflow(IDENTITY);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(calls);
  });

  it("answers an unknown strategy 400 UNKNOWN_STRATEGY", async () => {
    await expect(resolvePreviewWorkflow(IDENTITY, "nope")).rejects.toMatchObject({ status: 400, code: "UNKNOWN_STRATEGY" });
  });

  it("for a workflow that picks its writer at run time, writes with features-service's pick for the strategy and the picked dynasty's head", async () => {
    const plan = await resolvePreviewWorkflow(IDENTITY, "blind-emails-only");
    expect(plan).toMatchObject({ workflowSlug: "picked-v5", promptType: "blind-discovery-email-v4", model: "kimi-k2" });
    expect(mockResolveDynastyHead).toHaveBeenCalledWith("cold-reply-pain-question-blind");
    const writerUrl = mockFetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes("/public/stats/leg-writer-ranking"))!;
    const params = new URL(writerUrl).searchParams;
    expect(params.get("featureSlug")).toBe("sales-cold-email-outreach");
    expect(params.get("leg")).toBe("lead_found_to_conversation");
    expect(params.get("strategyId")).toBe("blind-emails-only");
  });

  it("a literal workflow never reads the writer pick", async () => {
    await resolvePreviewWorkflow(IDENTITY);
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("leg-writer-ranking"))).toBe(false);
    expect(mockResolveDynastyHead).not.toHaveBeenCalled();
  });

  it("fails loud when the writer pick cannot be read or names a dynasty with no head", async () => {
    mockFetch.mockImplementation(async (url: string) => (url.includes("leg-writer-ranking") ? json({ error: "x", reason: "writer_ranking_not_computed_yet" }, 503) : route(url)));
    await expect(resolvePreviewWorkflow(IDENTITY, "blind-emails-only")).rejects.toMatchObject({ status: 503, code: "WRITER_PICK_UNAVAILABLE" });

    __resetPreviewWorkflowCache();
    mockFetch.mockImplementation(async (url: string) => route(url));
    const { TemplateDynastyError } = await import("../../src/lib/template-dynasties.js");
    mockResolveDynastyHead.mockRejectedValue(new TemplateDynastyError(409, "DYNASTY_HAS_NO_VERSION", "no version"));
    await expect(resolvePreviewWorkflow(IDENTITY, "blind-emails-only")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("cold-reply-pain-question-blind") });
  });
});
