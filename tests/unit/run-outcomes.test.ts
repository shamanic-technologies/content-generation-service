import { describe, it, expect, vi, afterEach } from "vitest";
import { messageWrittenDeclaration, researchedCompanyDomain, postRunOutcomes, PermanentDeclarationError } from "../../src/lib/run-outcomes.js";

// COST-ACCOUNTING-1023-P1: each outcome key this service declares, and the subject it names.
describe("messageWrittenDeclaration", () => {
  it("produces message_written and consumes lead_found, both on the person's lead in lead-service", () => {
    expect(messageWrittenDeclaration({ leadId: "lead-1", variables: {} })).toEqual({
      produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
      consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
    });
  });

  it("also consumes company_researched on lead-service's company key (the domain, verbatim) when the company's checks were read", () => {
    const d = messageWrittenDeclaration({
      leadId: "lead-1",
      variables: { leadQualification: { domain: "acme.com", checks: [{ question: "q" }] } },
    });
    expect(d?.consumed).toEqual([
      { outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" },
      { outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "acme.com" },
    ]);
  });

  it("no checks, no domain: no company read, nothing consumed for it", () => {
    expect(researchedCompanyDomain({ leadQualification: { domain: "acme.com", checks: [] } })).toBeNull();
    expect(researchedCompanyDomain({ leadQualification: { domain: null, checks: [{}] } })).toBeNull();
    expect(researchedCompanyDomain({})).toBeNull();
    expect(researchedCompanyDomain(null)).toBeNull();
  });

  it("no lead: no subject to name, nothing declared (never an invented id)", () => {
    expect(messageWrittenDeclaration({ leadId: undefined })).toBeNull();
    expect(messageWrittenDeclaration({ leadId: "  " })).toBeNull();
  });
});

describe("postRunOutcomes", () => {
  afterEach(() => vi.unstubAllGlobals());
  const decl = { produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "l" }], consumed: [] };

  it("POSTs the body to /v1/runs/{id}/outcomes with the run's org; 200 (replay) and 201 succeed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 201 })).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postRunOutcomes("run-1", "org-1", decl)).toBe(201);
    expect(await postRunOutcomes("run-1", "org-1", decl)).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/runs\/run-1\/outcomes$/);
    expect(init.method).toBe("POST");
    expect(init.headers["x-org-id"]).toBe("org-1");
    expect(JSON.parse(init.body)).toEqual(decl);
  });

  it("400/404/409 are permanent; 5xx is retryable", async () => {
    for (const status of [400, 404, 409]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status })));
      await expect(postRunOutcomes("r", "o", decl)).rejects.toBeInstanceOf(PermanentDeclarationError);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 502 })));
    const err = await postRunOutcomes("r", "o", decl).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentDeclarationError);
  });
});
