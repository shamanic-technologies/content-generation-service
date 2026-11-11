import { describe, it, expect } from "vitest";
import { PreviewWriterError, keptScripts, previewVariables, scriptSlugOf, writerFromRanking, type ScriptStrategyAnswer, type WriterRanking } from "../../src/lib/preview-writer.js";

// PREVIEW-EMAIL-503-1111: the preview is written by the email Engine's script the strategy keeps, with the template +
// LLM features-service picks. These pin the rules: never a script the strategy rules out, never an invented fact.

const answer = (scripts: ScriptStrategyAnswer["scripts"]): ScriptStrategyAnswer => ({
  strategyId: null,
  keptDynasties: scripts.filter((s) => s.kept).map((s) => s.dynasty),
  scripts,
});

describe("keptScripts", () => {
  it("keeps the scripts features-service kept, with their version", () => {
    const kept = keptScripts(answer([
      { dynasty: "dy_template_writer_full", scriptId: "s1", version: 4, kept: true, reason: null },
      { dynasty: "dy_other", scriptId: "s2", version: 1, kept: false, reason: "excluded by Named angle" },
    ]));
    expect(kept).toEqual([{ dynasty: "dy_template_writer_full", version: 4 }]);
  });

  it("refuses by name when the strategy keeps no script, never another strategy's script", () => {
    const run = () => keptScripts(answer([{ dynasty: "dy_template_writer_full", scriptId: "s1", version: 4, kept: false, reason: "not judged on Blind angle" }]), "blind-emails-only");
    expect(run).toThrow(PreviewWriterError);
    try {
      run();
    } catch (e) {
      expect(e).toMatchObject({ status: 422, code: "NO_SCRIPT_KEPT" });
      expect((e as Error).message).toContain("blind-emails-only");
      expect((e as Error).message).toContain("not judged on Blind angle");
    }
  });

  it("refuses by name when the Engine has no runnable script at all", () => {
    expect(() => keptScripts(answer([]))).toThrow(/no runnable script/);
  });
});

const ranking = (over: Partial<WriterRanking> = {}): WriterRanking => ({
  computedAt: "2026-11-11T12:17:35Z",
  templates: { best: { templateDynastySlug: "cold-reply-three-line-reply-named" }, unavailableReason: null },
  llms: { best: { llmDynastySlug: "gemini-flash-lite", aliases: [{ alias: "flash", status: "active" }, { alias: "gemini-flash-lite", status: "active" }] }, unavailableReason: null },
  ...over,
});

describe("writerFromRanking", () => {
  it("takes the best template dynasty and the LLM dynasty slug when it is an active name", () => {
    expect(writerFromRanking(ranking())).toEqual({ templateDynastySlug: "cold-reply-three-line-reply-named", model: "gemini-flash-lite" });
  });

  it("else the first active name of the picked dynasty", () => {
    const r = ranking({ llms: { best: { llmDynastySlug: "kimi", aliases: [{ alias: "kimi-old", status: "deprecated" }, { alias: "kimi-k3", status: "active" }] }, unavailableReason: null } });
    expect(writerFromRanking(r).model).toBe("kimi-k3");
  });

  it("no pick = 503 WRITER_PICK_UNAVAILABLE, never a default", () => {
    for (const r of [ranking({ computedAt: null }), ranking({ templates: { best: null, unavailableReason: "nothing ranked" } }), ranking({ llms: { best: null, unavailableReason: "x" } })]) {
      expect(() => writerFromRanking(r, "named-emails-only")).toThrow(expect.objectContaining({ status: 503, code: "WRITER_PICK_UNAVAILABLE" }));
    }
  });
});

describe("previewVariables", () => {
  const recipient = { firstName: "Jane", lastName: "Doe", title: "VP Sales", companyName: "Acme", companyDomain: "acme.com" };
  const values = { recipient, clientName: "Brand Co", brandExtractedFields: { companyOverview: { value: "We do X" } }, currentDate: "2026-11-11" };

  it("fills the lead variables from the sample recipient and the brand's from brand-service, under the Engine's names", () => {
    expect(previewVariables(values, [])).toEqual({
      leadFirstName: "Jane",
      leadLastName: "Doe",
      leadTitle: "VP Sales",
      leadCompanyName: "Acme",
      leadCompanyWebsiteUrl: "acme.com",
      clientName: "Brand Co",
      brandExtractedFields: values.brandExtractedFields,
      currentDate: "2026-11-11",
    });
  });

  it("a lead fact the recipient lacks is empty when the template asks for it, and never left for brand-service", () => {
    const v = previewVariables(values, ["leadHeadline", "leadCompanySize", "leadCompanyFundingStage", "brandWebsiteUrl"]);
    expect(v.leadHeadline).toBe("");
    expect(v.leadCompanySize).toBe("");
    expect(v.leadCompanyFundingStage).toBe("");
    // A brand input stays unfilled here: the route asks brand-service for it (Convention 1).
    expect("brandWebsiteUrl" in v).toBe(false);
    // A lead fact neither carried nor asked is absent: nothing invented in the recipient block.
    expect("leadCompanyIndustry" in v).toBe(false);
  });
});

it("names the writer by Engine, dynasty and version", () => {
  expect(scriptSlugOf({ dynasty: "dy_template_writer_full", version: 4 })).toBe("message_written/dy_template_writer_full/v4");
});
