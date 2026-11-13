import { describe, it, expect } from "vitest";
import { PreviewWriterError, keptScripts, writerEngineOnCatalogue, previewVariables, scriptSlugOf, writerFromTactics, writingScriptsOf, type ScriptStrategyAnswer } from "../../src/lib/preview-writer.js";

// PREVIEW-EMAIL-503-1111: the preview is written by the email Engine's script the strategy keeps, with the template +
// LLM the cold email script the Rating picks states for its writing call (SCRIPT-VALUE-RATING-1113). These pin the rules: never a script the strategy rules out, never an invented fact.

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

describe("writerEngineOnCatalogue", () => {
  const cat = (t: Record<string, unknown>) => ({ channels: [{ slug: "sales-cold-email-outreach", channelType: "outbound", stepTransitions: [{ legKey: "lead_found_to_conversation", from: { key: "lead_found" }, ...t }] }] });
  it("the Engine the catalogue states on the cold email pipe, else its to step", () => {
    expect(writerEngineOnCatalogue(cat({ to: { key: "positive_reply" }, outcome: "email_sent" }))).toBe("email_sent");
    expect(writerEngineOnCatalogue(cat({ to: { key: "positive_reply" }, outcome: null }))).toBe("positive_reply");
  });
  it("no cold email pipe in the catalogue = 502, never a hand-typed Engine", () => {
    expect(() => writerEngineOnCatalogue({ channels: [] })).toThrow(expect.objectContaining({ status: 502 }));
    expect(() => writerEngineOnCatalogue(cat({ to: null, outcome: null }))).toThrow(expect.objectContaining({ status: 502 }));
  });
});

describe("writingScriptsOf", () => {
  const row = (dynasty: string, tactics: Record<string, unknown> | null, version = 1) => ({ dynasty, version, tactics });
  const rows = [
    row("dy_cold_email", { asks: ["message_written"], template: "t", llm: { model: "glm" } }),
    row("dy_cold_email", { asks: ["message_written"] }, 9),
    row("dy_pushed_email", { recorded_by: "email-gateway" }),
    row("dy_cold_email_site", { asks: ["message_written"] }),
  ];

  it("keeps the kept scripts that write their email through message_written, once each", () => {
    expect(writingScriptsOf(rows, ["dy_cold_email", "dy_pushed_email", "dy_cold_email_site"], "email_sent")).toEqual(["dy_cold_email", "dy_cold_email_site"]);
  });

  it("a script the strategy does not keep is never a candidate", () => {
    expect(writingScriptsOf(rows, ["dy_cold_email_site"], "email_sent")).toEqual(["dy_cold_email_site"]);
  });

  it("none writing = 422 NO_SCRIPT_KEPT", () => {
    expect(() => writingScriptsOf(rows, ["dy_pushed_email"], "email_sent")).toThrow(expect.objectContaining({ status: 422, code: "NO_SCRIPT_KEPT" }));
  });
});

describe("writerFromTactics", () => {
  const script = { dynasty: "dy_cold_email", version: 10 };

  it("the script-wide template + LLM the script states", () => {
    expect(writerFromTactics({ template: "cold-reply-three-line-reply-named", llm: { name: "Gemini Flash-Lite", provider: "google", model: "gemini-flash-lite" } }, script, "email_sent")).toEqual({ templateDynastySlug: "cold-reply-three-line-reply-named", model: "gemini-flash-lite" });
  });

  it("the writer call's own tactic wins over the script-wide one", () => {
    const tactics = { template: "wide", templates: { writer: "placed", angles: "x" }, llm: { model: "wide-llm" }, llms: { writer: { model: "placed-llm", provider: "zai" } } };
    expect(writerFromTactics(tactics, script, "email_sent")).toEqual({ templateDynastySlug: "placed", model: "placed-llm" });
  });

  it("a per-place map naming other calls only falls back to the script-wide tactic", () => {
    expect(writerFromTactics({ template: "wide", templates: { angles: "x" }, llm: { model: "m" }, llms: { judge: { model: "j" } } }, script, "email_sent")).toEqual({ templateDynastySlug: "wide", model: "m" });
  });

  it("no template or no LLM stated = a named refusal, never a default", () => {
    expect(() => writerFromTactics({ llm: { model: "m" } }, script, "email_sent")).toThrow(expect.objectContaining({ status: 422, code: "SCRIPT_STATES_NO_TEMPLATE" }));
    expect(() => writerFromTactics({ template: "t" }, script, "email_sent")).toThrow(expect.objectContaining({ status: 422, code: "SCRIPT_STATES_NO_LLM" }));
    expect(() => writerFromTactics(null, script, "email_sent")).toThrow(expect.objectContaining({ code: "SCRIPT_STATES_NO_TEMPLATE" }));
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
