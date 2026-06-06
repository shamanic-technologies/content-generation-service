import { describe, it, expect } from "vitest";
import { toExampleEmail, type ExampleRow } from "../../src/lib/examples-query.js";

function row(overrides: Partial<ExampleRow> = {}): ExampleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    subject: "Subject",
    bodyHtml: "<p>hi</p>",
    bodyText: "hi",
    sequence: [{ step: 1, bodyHtml: "<p>hi</p>", bodyText: "hi", daysSinceLastStep: 0 }],
    leadFirstName: "Jane",
    leadLastName: "Doe",
    leadCompany: "Acme",
    leadTitle: "CEO",
    leadIndustry: "SaaS",
    clientCompanyName: "OurCo",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    brandIds: ["brand-a", "brand-b"],
    scope: "brand",
    ...overrides,
  };
}

describe("toExampleEmail", () => {
  const names = new Map<string, string>([["brand-a", "Brand A"]]);

  it("brand scope: brandName is null even when the map has the source brand", () => {
    const out = toExampleEmail(row({ scope: "brand" }), names);
    expect(out.brandName).toBeNull();
    expect(out.scope).toBe("brand");
  });

  it("org scope: brandName resolves from the first brandId", () => {
    const out = toExampleEmail(row({ scope: "org" }), names);
    expect(out.brandName).toBe("Brand A");
  });

  it("global scope: brandName is null when the lookup did not return the source brand", () => {
    const out = toExampleEmail(row({ scope: "global", brandIds: ["brand-z"] }), names);
    expect(out.brandName).toBeNull();
  });

  it("no brandIds: brandName is null", () => {
    const out = toExampleEmail(row({ scope: "global", brandIds: [] }), names);
    expect(out.brandName).toBeNull();
  });

  it("null sequence becomes an empty array; createdAt becomes an ISO string", () => {
    const out = toExampleEmail(row({ sequence: null }), names);
    expect(out.sequence).toEqual([]);
    expect(out.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("nullable lead/content fields pass through unchanged", () => {
    const out = toExampleEmail(
      row({ scope: "org", subject: null, bodyHtml: null, bodyText: null, leadFirstName: null }),
      names
    );
    expect(out.subject).toBeNull();
    expect(out.bodyHtml).toBeNull();
    expect(out.bodyText).toBeNull();
    expect(out.leadFirstName).toBeNull();
  });
});
