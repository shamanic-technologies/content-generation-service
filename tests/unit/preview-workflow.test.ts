import { describe, it, expect } from "vitest";
import {
  matureCandidates,
  playCandidates,
  previewPlayId,
  planPreviewWorkflow,
  planNeedsBrandRows,
  resolvePreviewVariables,
  withWriter,
  writerFromRanking,
  type WriterRanking,
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
    expect(result.plan).toMatchObject({ workflowSlug: "wf-v5", writer: { kind: "literal", promptType: "blind-discovery-email-v33", model: "glm-pro" } });
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
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "" }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ model: "pro" }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "pro", disableThinking: true }, {})])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ type: "t", model: "pro" }, { "body.model": "$ref:x.output" })])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([])).ok).toBe(false);
  });

  it("reads a workflow that picks its writer at run time (template-head + writer-plan), and skips the lead's enrichment link", () => {
    const result = planPreviewWorkflow(
      wf([
        generateNode(
          {},
          {
            "body.type": "$ref:template-head.output.template.type",
            "body.model": "$ref:writer-plan.output.model",
            "body.leadId": "$ref:fetch-lead.output.lead.leadId",
            "body.apolloEnrichmentId": "$ref:fetch-lead.output.lead.data.apolloEnrichmentId",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          }
        ),
      ])
    );
    expect(result).toMatchObject({ ok: true, plan: { writer: { kind: "pick" }, sources: { leadFirstName: { kind: "recipient", field: "firstName" } } } });
    if (!result.ok) return;
    expect(withWriter(result.plan, "cold-email-v61", "kimi-k2")).toMatchObject({ promptType: "cold-email-v61", model: "kimi-k2", workflowSlug: "wf-v5" });
    expect("writer" in withWriter(result.plan, "t", "pro")).toBe(false);
  });

  it("calls unusable a template or model mapped from anything but the writer pick, or a literal mixed with a pick", () => {
    const pick = { "body.type": "$ref:template-head.output.template.type", "body.model": "$ref:writer-plan.output.model" };
    expect(planPreviewWorkflow(wf([generateNode({}, { ...pick, "body.model": "$ref:other.output.model" })])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({}, { "body.type": pick["body.type"] })])).ok).toBe(false);
    expect(planPreviewWorkflow(wf([generateNode({ model: "pro" }, pick)])).ok).toBe(false);
  });

  it("reads one value inside the brand intel (brand-extract-fields.output.fields.<key>.value)", () => {
    const result = planPreviewWorkflow(
      wf([extractNode, generateNode({ type: "t", model: "pro" }, { "body.variables.brandProfile": "$ref:brand-extract-fields.output.fields.companyOverview.value" })])
    );
    expect(result).toMatchObject({ ok: true, plan: { sources: { brandProfile: { kind: "brand-intel-path", path: "fields.companyOverview.value" } }, brandIntelFields: [{ key: "companyOverview" }] } });
    if (!result.ok) return;
    const plan = withWriter(result.plan, "t", "pro");
    const values = { recipient: { firstName: "A", lastName: "B", title: "C", companyName: "D" }, brandIntel: { fields: { companyOverview: { value: "We sell X" } } }, brands: null, currentDate: "2026-10-23" };
    expect(resolvePreviewVariables(plan, values, ["brandProfile"])).toEqual({ brandProfile: "We sell X" });
    expect(resolvePreviewVariables(plan, { ...values, brandIntel: {} }, ["brandProfile"])).toEqual({ brandProfile: "" });
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

  it("resolves what the preview holds, leaves unknown template inputs empty, omits unknown non-template facts, and leaves unmapped tokens to brand-service", () => {
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
    });
    expect("leadHeadline" in v).toBe(false);
  });
});

describe("playCandidates", () => {
  const row = (rank: number, slug: string, extra: Record<string, unknown> = {}) => ({ rank, workflowDynastySlug: slug, selectable: true, isMature: false, basis: "flash" as const, costPerOutcomeUsd: null, moneyGoesHere: false, ...extra });
  const ranking = { computedAt: "2026-10-17T00:00:00Z", rows: [row(1, "a"), row(2, "b"), row(3, "c", { executable: false }), row(4, "d", { isMature: true, basis: "mature", costPerOutcomeUsd: 9, moneyGoesHere: true })] };

  it("keeps only the play's workflows, in rank order, learning ones included", () => {
    const out = playCandidates(ranking, { id: "p", allowedWorkflowDynastySlugs: ["b", "a"], bestWorkflowSlug: null });
    expect(out.map((r) => r.workflowDynastySlug)).toEqual(["a", "b"]);
  });

  it("puts the play's measured best first and never a workflow the leg cannot execute", () => {
    const out = playCandidates(ranking, { id: "p", allowedWorkflowDynastySlugs: ["a", "b", "c"], bestWorkflowSlug: "b" });
    expect(out.map((r) => r.workflowDynastySlug)).toEqual(["b", "a"]);
  });

  it("never falls back to a workflow outside the play", () => {
    expect(() => playCandidates(ranking, { id: "p", allowedWorkflowDynastySlugs: ["c", "zz"], bestWorkflowSlug: null })).toThrow(/allows no workflow/);
    expect(() => playCandidates({ computedAt: null, rows: [] }, { id: "p", allowedWorkflowDynastySlugs: ["a"], bestWorkflowSlug: null })).toThrow(/computedAt/);
  });

  it("names the play on the cold-email pipe", () => {
    expect(previewPlayId("blind-emails-only")).toBe("sales-cold-email-outreach|lead_found_to_conversation~blind-emails-only");
  });
});

describe("writerFromRanking", () => {
  const ranking = (o: Partial<WriterRanking> = {}): WriterRanking => ({
    computedAt: "2026-10-23T00:00:00Z",
    templates: { best: { templateDynastySlug: "cold-reply-pain-question-blind" }, unavailableReason: null },
    llms: {
      best: { llmDynastySlug: "kimi-k2", aliases: [{ alias: "kimi-flash", status: "active" }, { alias: "kimi-k2", status: "active" }] },
      unavailableReason: null,
    },
    ...o,
  });

  it("serves the best template dynasty and the LLM by its dynasty slug, as writer-pick names it", () => {
    expect(writerFromRanking(ranking())).toEqual({ templateDynastySlug: "cold-reply-pain-question-blind", model: "kimi-k2" });
  });

  it("falls to the first active alias when the dynasty slug is not an active name, as writer-pick does", () => {
    const r = ranking({ llms: { best: { llmDynastySlug: "gemini-pro", aliases: [{ alias: "gemini-pro", status: "deprecated" }, { alias: "pro", status: "active" }] }, unavailableReason: null } });
    expect(writerFromRanking(r).model).toBe("pro");
  });

  it("fails loud, in plain words, when features-service picks no template or no LLM", () => {
    expect(() => writerFromRanking(ranking({ computedAt: null }))).toThrow(/has not computed which template and LLM/);
    expect(() => writerFromRanking(ranking({ templates: { best: null, unavailableReason: "every_template_excluded" } }), "blind-emails-only")).toThrow(
      /picks no template to write with on the cold-email pipe under strategy blind-emails-only \(every_template_excluded\)/
    );
    expect(() => writerFromRanking(ranking({ llms: { best: { llmDynastySlug: "x", aliases: [{ alias: "x", status: "deprecated" }] }, unavailableReason: null } }))).toThrow(/picks no LLM/);
    try {
      writerFromRanking(ranking({ llms: { best: null, unavailableReason: "no_llm" } }));
    } catch (e) {
      expect(e).toMatchObject({ status: 503, code: "WRITER_PICK_UNAVAILABLE" });
    }
  });
});
