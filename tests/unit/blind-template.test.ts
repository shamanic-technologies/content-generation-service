import { describe, it, expect } from "vitest";
import { isBlindTemplateType } from "../../src/lib/blind-template-rule";

describe("isBlindTemplateType", () => {
  it("covers every version of both blind families, nothing else", () => {
    for (const t of ["blind-discovery-email", "blind-discovery-email-v34", "blind-discovery-email-v9-landing-v3", "feedback-request-blind-email-v1"]) {
      expect(isBlindTemplateType(t)).toBe(true);
    }
    for (const t of ["cold-email-v49", "feedback-request-email-v1", "blind-discovery-emailx", "expert-quote-pitch"]) {
      expect(isBlindTemplateType(t)).toBe(false);
    }
  });
});
