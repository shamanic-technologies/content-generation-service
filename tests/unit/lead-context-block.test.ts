import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildLeadContextBlock } from "../../src/lib/lead-context-block";
import {
  LEAD_CONTEXT_VARIABLES,
  LEAD_CONTEXT_VARIABLES_PUBLISHED,
  withoutUnquotableBuyingSignal,
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

async function promptSentFor(variables: Record<string, unknown>, promptTemplate = TEMPLATE): Promise<string> {
  mockFetch.mockResolvedValueOnce(successResponse());
  await generateFromTemplate({ promptTemplate, variables }, IDENTITY);
  const [, opts] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
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

// ---------------------------------------------------------------------------
// Buying signal (`leadBuyingSignal`), served by lead-service on signal leads
// ---------------------------------------------------------------------------

const SIGNAL = {
  type: "hiring",
  occurredOn: "2026-09-21",
  fact: "Acme Clinics posted a job for Office Manager (Austin, United States) on September 21, 2026",
  source: "apollo:job_postings",
  sourceUrl: "https://example.com/jobs/123",
};

describe("leadBuyingSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is published in the context catalog", () => {
    const published = LEAD_CONTEXT_VARIABLES_PUBLISHED.find((v) => v.name === "leadBuyingSignal");
    expect(published).toBeDefined();
    expect(published!.description).toContain("job_change");
  });

  it("renders the fact, kind and date, never the provenance", () => {
    const out = block({ leadBuyingSignal: SIGNAL });
    expect(out).toContain("Recent buying signal");
    expect(out).toContain(`- what happened: ${SIGNAL.fact}`);
    expect(out).toContain("- kind: hiring");
    expect(out).toContain("- date: 2026-09-21");
    expect(out).not.toContain("apollo:job_postings");
    expect(out).not.toContain(SIGNAL.sourceUrl);
    expect(out).not.toContain("—");
  });

  it("humanizes job_change", () => {
    expect(block({ leadBuyingSignal: { ...SIGNAL, type: "job_change" } })).toContain("- kind: job change");
  });

  it("renders nothing for a signal without a usable fact", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(block({ leadBuyingSignal: { ...SIGNAL, fact: "  " } })).toBe("");
    expect(block({ leadBuyingSignal: "hiring" })).toBe("");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("puts the fact and date in the prompt sent to the model", async () => {
    const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme", leadBuyingSignal: SIGNAL };
    const sent = await promptSentFor(variables);
    expect(sent).toContain(SIGNAL.fact);
    expect(sent).toContain("2026-09-21");
    expect(sent).toContain(substituteVariables(TEMPLATE, variables));
  });

  it("leaves the prompt byte-identical when the key is absent", async () => {
    const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme", leadCity: "Berlin" };
    const withoutKey = await promptSentFor(variables);
    expect(withoutKey).not.toContain("buying signal");
    expect(withoutKey.toLowerCase()).not.toContain("signal");
  });
});

// ---------------------------------------------------------------------------
// linkedin_engagement: the signal chooses WHO we write to, never WHAT we write
// ---------------------------------------------------------------------------

const ENGAGEMENT_SIGNAL = {
  type: "linkedin_engagement",
  occurredOn: "2026-09-30",
  fact: "Sarah Lee commented on Rivalco's LinkedIn post on September 30, 2026",
  source: "linkedin:company/rivalco",
  sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
  engagement: {
    competitorPage: "https://www.linkedin.com/company/rivalco",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
    postPublishedOn: "2026-09-29",
    kind: "comment",
    reactionType: null,
    commentText: "Great take on onboarding automation",
    commentedAt: "2026-09-30T10:00:00Z",
  },
};

function expectNoEngagementTrace(text: string): void {
  for (const needle of [
    ENGAGEMENT_SIGNAL.fact,
    "Rivalco",
    "rivalco",
    "linkedin_engagement",
    "linkedin engagement",
    "activity:123",
    "commented",
    "onboarding automation",
    "2026-09-30",
    "buying signal",
  ]) {
    expect(text).not.toContain(needle);
  }
}

describe("leadBuyingSignal of kind linkedin_engagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves no trace of the engagement, the competitor or the post in the prompt", async () => {
    const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme", leadCity: "Berlin", leadBuyingSignal: ENGAGEMENT_SIGNAL };
    const sent = await promptSentFor(variables);
    expectNoEngagementTrace(sent);
    // The rest of the recipient context is still there.
    expect(sent).toContain("- city: Berlin");
  });

  it("sends exactly the prompt the lead would get with no signal at all", async () => {
    const base = { leadFirstName: "Sarah", leadCompanyName: "Acme", leadCity: "Berlin" };
    const withEngagement = await promptSentFor({ ...base, leadBuyingSignal: ENGAGEMENT_SIGNAL });
    const withoutSignal = await promptSentFor(base);
    expect(withEngagement).toBe(withoutSignal);
  });

  it("is not rendered through a {{leadBuyingSignal}} token either", async () => {
    const sent = await promptSentFor(
      { leadFirstName: "Sarah", leadCompanyName: "Acme", leadBuyingSignal: ENGAGEMENT_SIGNAL },
      "Write to {{leadFirstName}}. Signal: {{leadBuyingSignal}}"
    );
    expectNoEngagementTrace(sent);
  });

  it("treats an unknown or missing kind the same way: a kind is quotable only once listed", () => {
    expect(withoutUnquotableBuyingSignal({ leadBuyingSignal: { ...SIGNAL, type: "web_visit" } })).toEqual({});
    expect(withoutUnquotableBuyingSignal({ leadBuyingSignal: { fact: SIGNAL.fact } })).toEqual({});
  });

  it("keeps hiring, job_change and funding byte-identical", async () => {
    for (const type of ["hiring", "job_change", "funding"]) {
      const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme", leadBuyingSignal: { ...SIGNAL, type } };
      expect(withoutUnquotableBuyingSignal(variables)).toBe(variables);
      const sent = await promptSentFor(variables);
      expect(sent).toContain(`- what happened: ${SIGNAL.fact}`);
      expect(sent).toContain(`- kind: ${type.replace("_", " ")}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Offer checks on the recipient's company (`leadQualification`), served by
// lead-service on every lead as `lead.qualification`
// ---------------------------------------------------------------------------

const QUALIFICATION = {
  domain: "acme.com",
  checks: [
    {
      criterionId: "c1",
      offerId: "o1",
      question: "Does the site load in under 3 seconds on mobile?",
      mode: "must_pass",
      source: "PageSpeed mobile run",
      verdict: "yes",
      yesProbability: 0.92,
      evidence: "The home page loaded in 1.8 seconds on a mobile connection.",
      screenshotUrl: "https://cdn.example.com/shots/acme-mobile.png",
      reason: null,
      checkedAt: "2026-10-07T09:00:00Z",
    },
    {
      criterionId: "c2",
      offerId: "o1",
      question: "Does the company publish a newsletter?",
      mode: "mention",
      source: "Site crawl",
      verdict: "no",
      yesProbability: 0.08,
      evidence: "No newsletter signup form was found on acme.com.",
      screenshotUrl: null,
      reason: null,
      checkedAt: "2026-10-07T09:00:00Z",
    },
    {
      criterionId: "c3",
      offerId: "o1",
      question: "Is the company hiring for support roles?",
      mode: "mention",
      source: "Job boards",
      verdict: "unavailable",
      yesProbability: null,
      evidence: null,
      screenshotUrl: null,
      reason: "The careers page could not be reached.",
      checkedAt: "2026-10-07T09:00:00Z",
    },
  ],
};

describe("leadQualification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is published in the context catalog", () => {
    const published = LEAD_CONTEXT_VARIABLES_PUBLISHED.find((v) => v.name === "leadQualification");
    expect(published).toBeDefined();
    expect(published!.description).toContain("must_pass");
  });

  it("puts every check, passed or failed, in the prompt sent to the model", async () => {
    const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme", leadQualification: QUALIFICATION };
    const sent = await promptSentFor(variables);

    expect(sent).toContain("- company checked: acme.com");
    expect(sent).toContain(
      [
        "1. Does the site load in under 3 seconds on mobile?",
        "   role: Hard filter",
        "   outcome: pass",
        "   evidence: The home page loaded in 1.8 seconds on a mobile connection.",
        "   screenshot: https://cdn.example.com/shots/acme-mobile.png",
      ].join("\n")
    );
    expect(sent).toContain(
      [
        "2. Does the company publish a newsletter?",
        "   role: Bonus",
        "   outcome: fail",
        "   evidence: No newsletter signup form was found on acme.com.",
      ].join("\n")
    );
    expect(sent).toContain(
      [
        "3. Is the company hiring for support roles?",
        "   role: Bonus",
        "   outcome: could not check",
        "   reason: The careers page could not be reached.",
      ].join("\n")
    );
    expect(sent).toContain(substituteVariables(TEMPLATE, variables));
  });

  it("never tells the model it must mention the checks, and adds no dashes", () => {
    const out = block({ leadQualification: QUALIFICATION });
    expect(out).not.toMatch(/\bmust\b|\balways\b|\brequired?\b|\bmention\b/i);
    expect(out).not.toMatch(/[–—]/);
  });

  it("renders nothing, silently, for an offer with no checks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(block({ leadQualification: { domain: "acme.com", checks: [] } })).toBe("");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("renders nothing for a value that is not lead-service's shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(block({ leadQualification: "yes" })).toBe("");
    expect(block({ leadQualification: { domain: "acme.com" } })).toBe("");
    expect(block({ leadQualification: { checks: [{ verdict: "yes" }] } })).toBe("");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the prompt byte-identical when the key is absent or the checks are empty", async () => {
    const variables = { leadFirstName: "Sarah", leadCompanyName: "Acme" };
    const before = await promptSentFor(variables);
    expect(before).toBe(substituteVariables(TEMPLATE, variables));
    const empty = await promptSentFor({ ...variables, leadQualification: { domain: "acme.com", checks: [] } });
    expect(empty).toBe(before);
  });

  it("is not repeated in the block when the template consumes it as a token", () => {
    expect(block({ leadQualification: QUALIFICATION }, "Checks: {{leadQualification}}")).toBe("");
  });
});
