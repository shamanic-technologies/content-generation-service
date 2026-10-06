import { describe, it, expect, vi, beforeEach } from "vitest";
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
};

function route(url: string) {
  if (url.includes("/public/stats/leg-workflow-ranking")) return json(ranking);
  const slug = new URL(url).searchParams.get("workflowDynastySlug")!;
  return json(workflows[slug]);
}

beforeEach(() => {
  mockFetch.mockReset();
  __resetPreviewWorkflowCache();
  mockFetch.mockImplementation(async (url: string) => route(url));
});

describe("resolvePreviewWorkflow", () => {
  it("reads the positive-reply leg ranking of the cold-email feature and skips a best workflow a preview cannot reproduce", async () => {
    const plan = await resolvePreviewWorkflow(IDENTITY);
    expect(plan).toMatchObject({ workflowSlug: "plain-v3", promptType: "cold-email-v55", model: "flash-lite" });
    const rankingUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(rankingUrl.searchParams.get("featureSlug")).toBe("sales-cold-email-outreach");
    expect(rankingUrl.searchParams.get("leg")).toBe("start_to_conversation");
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
});
