import { describe, it, expect } from "vitest";
import {
  matureCandidates,
  planPreviewWorkflow,
  planNeedsBrandRows,
  resolvePreviewVariables,
  PreviewWorkflowError,
  type LegRankingRow,
} from "../../src/lib/preview-workflow.js";

const row = (o: Partial<LegRankingRow>): LegRankingRow => ({
  rank: 1,
  workflowDynastySlug: "d",
  selectable: true,
  isMature: true,
  basis: "mature",
  costPerOutcomeUsd: 10,
  moneyGoesHere: false,
  ...o,
});

describe("matureCandidates", () => {
  it("puts the best mature workflow first, then the other selectable mature ones in rank order; never a learning one", () => {
    const rows = [
      row({ rank: 1, workflowDynastySlug: "learning-cheap", isMature: false, basis: "flash", costPerOutcomeUsd: 5 }),
      row({ rank: 2, workflowDynastySlug: "best", moneyGoesHere: true }),
      row({ rank: 4, workflowDynastySlug: "third", costPerOutcomeUsd: 30 }),
      row({ rank: 3, workflowDynastySlug: "second", costPerOutcomeUsd: 20 }),
      row({ rank: 5, workflowDynastySlug: "deprecated", selectable: false, costPerOutcomeUsd: 25 }),
    ];
    expect(matureCandidates({ computedAt: "2026-10-06T00:00:00Z", rows }).map((r) => r.workflowDynastySlug)).toEqual(["best", "second", "third"]);
  });

  it("fails loud when the ranking was never computed or names no best mature workflow", () => {
    expect(() => matureCandidates({ computedAt: null, rows: [] })).toThrow(PreviewWorkflowError);
    expect(() => matureCandidates({ computedAt: "x", rows: [row({ isMature: false, basis: "flash" })] })).toThrow(/no best mature workflow/);
    try {
      matureCandidates({ computedAt: null, rows: [] });
    } catch (e) {
      expect((e as PreviewWorkflowError).status).toBe(503);
    }
  });
});

const generateNode = (body: Record<string, unknown>, inputMapping: Record<string, unknown>) => ({
  id: "email-generate",
  type: "http.call",
  config: { service: "content-generation", method: "POST", path: "/generate", body },
  inputMapping,
});
const extractNode = {
  id: "brand-extract-fields",
  type: "http.call",
  config: { service: "brand", method: "POST", path: "/orgs/brands/extract-fields", body: { fields: [{ key: "companyOverview", description: "Overview" }] } },
};
const wf = (nodes: unknown[]) => ({ workflowSlug: "wf-v5", workflowDynastySlug: "wf", dag: { nodes, edges: [] } });

describe("planPreviewWorkflow", () => {
  it("reads the template + model the DAG's /generate node states, and the source of every input", () => {
    const result = planPreviewWorkflow(
      wf([
        extractNode,
        generateNode(
          { type: "blind-discovery-email-v33", model: "glm-pro" },
          {
            "body.leadId": "$ref:fetch-lead.output.lead.leadId",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
            "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.currentTitle",
            "body.variables.leadCompanySize": "$ref:fetch-lead.output.lead.data.organization.estimatedNumEmployees",
            "body.variables.brandExtractedFields": "$ref:brand-extract-fields.output.fields",
            "body.variables.brands": "$ref:brands-fetch.output.brands",
            "body.variables.brandWebsiteUrl": "$ref:brand-profile.output.brand.clickDestinationUrl",
            "body.variables.currentDate": "$ref:flow_input.currentDate",
          }
        ),
      ])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ workflowSlug: "wf-v5", promptType: "blind-discovery-email-v33", model: "glm-pro" });
    expect(result.plan.brandIntelFields).toEqual([{ key: "companyOverview", description: "Overview" }]);
    expect(result.plan.sources).toEqual({
      leadFirstName: { kind: "recipient", field: "firstName" },
      leadTitle: { kind: "recipient", field: "title" },
      leadCompanySize: { kind: "lead-unknown", path: "organization.estimatedNumEmployees" },
      brandExtractedFields: { kind: "brand-intel", part: "fields" },
      brands: { kind: "brands" },
      brandWebsiteUrl: { kind: "brand", path: "clickDestinationUrl" },
      currentDate: { kind: "current-date" },
    });
    expect(planNeedsBrandRows(result.plan)).toBe(true);
  });

  it("calls a -landing workflow unusable: a preview has no scraped lead page", () => {
    const result = planPreviewWorkflow(
      wf([generateNode({ type: "cold-email-v39-landing", model: "pro" }, { "body.variables.landingPageContent": "$ref:landing-content.output.value" })])
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("landingPageContent") });
  });

  it("calls unusable a model or template that is not a literal, or a /generate setting the preview does not reproduce", () => {
    expect(planPreviewWorkflow(wf([generateNode({ type: "t" }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "not-a-model" }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ model: "pro" }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "pro", disableThinking: true }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "pro" }, { "body.model": "$ref:x.output" })])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([])).ok).toBe(false);
  });

  it("calls unusable a brand-intel workflow whose extract node states no literal field list", () => {
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "pro" }, { "body.variables.brandExtractedFields": "$ref:brand-extract-fields.output" })])).ok).toBe(false);
  });
});

describe("resolvePreviewVariables", () => {
  const plan = {
    workflowSlug: "wf-v5",
    workflowDynastySlug: "wf",
    promptType: "t",
    model: "pro" as const,
    brandIntelFields: null,
    sources: {
      leadFirstName: { kind: "recipient", field: "firstName" },
      leadCompanyIndustry: { kind: "recipient", field: "companyIndustry" },
      leadCompanySize: { kind: "lead-unknown", path: "organization.estimatedNumEmployees" },
      leadCity: { kind: "lead-unknown", path: "city" },
      brandExtractedFields: { kind: "brand-intel", part: "whole" },
      clientName: { kind: "brand", path: "name" },
      clientWebsite: { kind: "brand", path: "clickDestinationUrl" },
      currentDate: { kind: "current-date" },
    },
  } as const;

  it("resolves what the preview holds, leaves unknown template inputs empty, and omits unknown non-template facts", () => {
    const intel = { brands: [], fields: { a: 1 } };
    const v = resolvePreviewVariables(
      plan as never,
      {
        recipient: { firstName: "Jane", lastName: "Doe", title: "VP", companyName: "Acme" },
        brandIntel: intel,
        brands: [{ id: "b", name: "Brand Co", clickDestinationUrl: null }],
        currentDate: "2026-10-06",
      },
      ["leadFirstName", "leadCompanyIndustry", "leadCompanySize", "clientName", "clientWebsite", "brandExtractedFields", "currentDate", "leadHeadline"]
    );
    expect(v).toEqual({
      leadFirstName: "Jane",
      leadCompanyIndustry: "",
      leadCompanySize: "",
      brandExtractedFields: intel,
      clientName: "Brand Co",
      clientWebsite: "",
      currentDate: "2026-10-06",
      leadHeadline: "",
    });
  });
});
