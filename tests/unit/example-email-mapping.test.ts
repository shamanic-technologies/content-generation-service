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

  it("nullable lead fields pass through unchanged", () => {
    const out = toExampleEmail(row({ scope: "org", subject: null, leadFirstName: null }), names);
    expect(out.subject).toBeNull();
    expect(out.leadFirstName).toBeNull();
  });

  it("empty body columns resolve from the sequence (every example written since Feb 2026)", () => {
    const out = toExampleEmail(row({ scope: "org", bodyHtml: null, bodyText: null }), names);
    expect(out.bodyText).toBe("hi");
    expect(out.bodyHtml).toBe("<p>hi</p>");
    expect(out.bodySource).toBe("sequence");
  });

  it("an example with no copy anywhere is marked `none`, not empty copy", () => {
    const out = toExampleEmail(
      row({ scope: "org", bodyHtml: null, bodyText: null, sequence: [] }),
      names
    );
    expect(out.bodyText).toBeNull();
    expect(out.bodyHtml).toBeNull();
    expect(out.bodySource).toBe("none");
  });

  it("populated body columns win and are reported as `column`", () => {
    const out = toExampleEmail(row({ scope: "org" }), names);
    expect(out.bodyText).toBe("hi");
    expect(out.bodySource).toBe("column");
  });
});
