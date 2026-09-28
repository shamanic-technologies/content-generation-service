import { describe, it, expect } from "vitest";
import { buildPreviewVariables, buildPreviewContext, previewRecipientKey } from "../../src/lib/preview-email.js";

const R = { firstName: "Jane", lastName: "Doe", title: "VP Sales", companyName: "Acme" };

describe("previewRecipientKey", () => {
  const base = { recipient: R, promptType: "cold-email-v39", model: "pro" };

  it("treats casing and stray whitespace as the same recipient", () => {
    const a = previewRecipientKey(base);
    const b = previewRecipientKey({ ...base, recipient: { ...R, firstName: " jane ", companyName: "ACME" } });
    expect(a).toBe(b);
  });

  it("changes with anything that changes the written email", () => {
    const a = previewRecipientKey(base);
    expect(previewRecipientKey({ ...base, recipient: { ...R, title: "CEO" } })).not.toBe(a);
    expect(previewRecipientKey({ ...base, audience: "SaaS" })).not.toBe(a);
    expect(previewRecipientKey({ ...base, model: "flash" })).not.toBe(a);
    expect(previewRecipientKey({ ...base, offerId: "o" })).not.toBe(a);
  });
});

describe("buildPreviewVariables", () => {
  it("fills every template token the caller could not supply with an empty string", () => {
    const v = buildPreviewVariables(R, "Brand", { fields: {} }, ["leadFirstName", "leadCompanyIndustry", "leadHeadline"]);
    expect(v.leadFirstName).toBe("Jane");
    expect(v.leadCompanyIndustry).toBe("");
    expect(v.leadHeadline).toBe("");
    expect(v.clientName).toBe("Brand");
  });
});

describe("buildPreviewContext", () => {
  it("is null without an audience", () => {
    expect(buildPreviewContext(undefined)).toBeNull();
    expect(buildPreviewContext("  ")).toBeNull();
    expect(buildPreviewContext("SaaS founders")).toEqual({ audience: "SaaS founders" });
  });
});
