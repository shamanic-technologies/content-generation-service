import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildLeadContextBlock } from "../../src/lib/lead-context-block";
import {
  LEAD_CONTEXT_VARIABLES,
  LEAD_CONTEXT_VARIABLES_PUBLISHED,
} from "../../src/lib/lead-context-variables";
import {
  coerceToString,
  generateFromTemplate,
  substituteVariables,
} from "../../src/lib/chat-service-client";

const TEMPLATE = "Write a cold email to {{leadFirstName}} at {{leadCompanyName}}.";

function block(variables: Record<string, unknown>, template = TEMPLATE): string {
  return buildLeadContextBlock(template, variables, coerceToString);
}

describe("lead context catalog", () => {
  it("publishes every variable as a self-describing { name, description }", () => {
    expect(LEAD_CONTEXT_VARIABLES_PUBLISHED.length).toBe(LEAD_CONTEXT_VARIABLES.length);
    for (const v of LEAD_CONTEXT_VARIABLES_PUBLISHED) {
      expect(typeof v.name).toBe("string");
      expect(v.name.length).toBeGreaterThan(0);
      expect(typeof v.description).toBe("string");
      expect(v.description.length).toBeGreaterThan(0);
      expect(Object.keys(v).sort()).toEqual(["description", "name"]);
    }
  });

  it("declares unique names", () => {
    const names = LEAD_CONTEXT_VARIABLES.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers the person and organization fields lead-service serves", () => {
    const names = new Set(LEAD_CONTEXT_VARIABLES.map((v) => v.name));
    for (const expected of [
      "leadSeniority",
      "leadDepartments",
      "leadFunctions",
      "leadCity",
      "leadState",
      "leadCountry",
      "leadTimezone",
      "leadBusinessLanguages",
      "leadLinkedinUrl",
      "leadEmploymentHistory",
      "leadCompanySeoDescription",
      "leadCompanyIndustries",
      "leadCompanySecondaryIndustries",
      "leadCompanyFoundedYear",
      "leadCompanyAnnualRevenue",
      "leadCompanyTotalFunding",
      "leadCompanyFundingEvents",
      "leadCompanyWebsiteUrl",
      "leadCompanyLinkedinUrl",
      "leadCompanyCity",
      "leadCompanyState",
      "leadCompanyCountry",
      "leadSubdepartments",
      "leadCompanyLatestFundingRoundDate",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("uses no em-dash in any published description", () => {
    for (const v of LEAD_CONTEXT_VARIABLES_PUBLISHED) {
      expect(v.description).not.toContain("—");
    }
  });
});

describe("buildLeadContextBlock", () => {
  it("returns nothing when the caller sends no context variables", () => {
    expect(block({ leadFirstName: "Sarah", leadCompanyName: "Acme" })).toBe("");
  });

  it("returns nothing when the context variables are present but empty", () => {
    expect(
      block({
        leadCity: "",
        leadDepartments: [],
        leadEmploymentHistory: [],
        leadCompanyFundingEvents: {},
        leadCompanyFoundedYear: null,
        leadTimezone: undefined,
      })
    ).toBe("");
  });

  it("renders supplied person and organization facts under their headings", () => {
    const out = block({
      leadFirstName: "Sarah",
      leadSeniority: "vp",
      leadCity: "Berlin",
      leadCompanyFoundedYear: 2014,
      leadCompanyIndustries: ["software", "logistics"],
    });

    expect(out).toContain("## Recipient context");
    expect(out).toContain("Person:");
    expect(out).toContain("- seniority: vp");
    expect(out).toContain("- city: Berlin");
    expect(out).toContain("Organization:");
    expect(out).toContain("- founded year: 2014");
    expect(out).toContain("- industries: software, logistics");
  });

  it("renders sub-departments and the latest funding round date when supplied", () => {
    const out = block({
      leadDepartments: ["information_technology"],
      leadSubdepartments: ["devops", "information_technology"],
      leadCompanyFundingStage: "series_a",
      leadCompanyLatestFundingRoundDate: "2024-06-01",
    });

    expect(out).toContain("- departments: information_technology");
    expect(out).toContain("- sub-departments: devops, information_technology");
    expect(out).toContain("- funding stage: series_a");
    expect(out).toContain("- latest funding round date: 2024-06-01");
  });

  it("renders nothing for the two newest variables when they are absent or empty", () => {
    const out = block({
      leadDepartments: ["information_technology"],
      leadSubdepartments: [],
      leadCompanyLatestFundingRoundDate: null,
    });

    expect(out).toContain("- departments: information_technology");
    expect(out).not.toContain("sub-departments");
    expect(out).not.toContain("latest funding round date");
  });

  it("never repeats a fact the template body already consumes", () => {
    const out = block(
      { leadFirstName: "Sarah", leadCity: "Berlin" },
      "Write to {{leadFirstName}} in {{leadCity}}."
    );
    expect(out).toBe("");
  });

  it("renders employment history as a numbered list", () => {
    const out = block({
      leadEmploymentHistory: [
        { title: "VP Engineering", company: "Acme", start: "2021-03", end: null, current: true },
        { title: "Staff Engineer", company: "Globex", start: "2017-01", end: "2021-02", current: false },
      ],
    });

    expect(out).toContain("- employment history:");
    expect(out).toContain("VP Engineering");
    expect(out).toContain("Globex");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
  });

  it("tells the model not to state anything that is not listed", () => {
    const out = block({ leadCountry: "France" });
    expect(out.toLowerCase()).toContain("never state anything that is not here");
  });

  it("uses no em-dash", () => {
    const out = block({ leadCountry: "France", leadCompanyTotalFunding: "$12M" });
    expect(out).not.toContain("—");
  });
});

// ---------------------------------------------------------------------------
// Rendering through the real generation path, with and without the new inputs
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };

function successResponse() {
  const jsonPayload = { subject: "Test", emails: [{ body: "Hi", daysSinceLastStep: 0 }] };
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        content: JSON.stringify(jsonPayload),
        json: jsonPayload,
        tokensInput: 10,
        tokensOutput: 5,
        model: "gemini-3-pro",
      }),
  };
}

async function promptSentFor(variables: Record<string, unknown>): Promise<string> {
  mockFetch.mockResolvedValueOnce(successResponse());
  await generateFromTemplate({ promptTemplate: TEMPLATE, variables }, IDENTITY);
  const [, opts] = mockFetch.mock.calls[0];
  return JSON.parse(opts.body).message as string;
}

describe("generateFromTemplate with lead context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a byte-identical prompt when only today's variables are supplied", async () => {
    const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme" };
    const sent = await promptSentFor(variables);
    expect(sent).toBe(substituteVariables(TEMPLATE, variables));
  });

  it("prepends the recipient context when the new variables are supplied", async () => {
    const variables = {
      leadFirstName: "Sarah",
      leadCompanyName: "Acme",
      leadSeniority: "vp",
      leadCompanyFoundedYear: 2014,
      leadCompanyFundingEvents: [{ type: "series_a", amount: "$12M", date: "2023-06" }],
    };
    const sent = await promptSentFor(variables);

    expect(sent.startsWith("## Recipient context")).toBe(true);
    expect(sent).toContain("- seniority: vp");
    expect(sent).toContain("- founded year: 2014");
    expect(sent).toContain("series_a");
    // The template itself still renders exactly as before, after the block.
    expect(sent).toContain(substituteVariables(TEMPLATE, variables));
  });

  it("ignores unknown variables — only the declared context catalog is rendered", async () => {
    const sent = await promptSentFor({
      leadFirstName: "Sarah",
      leadCompanyName: "Acme",
      leadCity: "Berlin",
      internalScoringDebug: "do-not-leak",
    });

    expect(sent).toContain("- city: Berlin");
    expect(sent).not.toContain("do-not-leak");
  });
});
