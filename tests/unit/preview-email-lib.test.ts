import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPreviewContext, previewRecipientKey } from "../../src/lib/preview-email.js";

const R = { firstName: "Jane", lastName: "Doe", title: "VP Sales", companyName: "Acme" };

describe("previewRecipientKey", () => {
  const base = { recipient: R, promptType: "blind-discovery-email-v33", model: "glm-pro", workflowSlug: "sales-cold-email-outreach-nobelium-v5", annotationVersion: "highlights-v1" };

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
    expect(previewRecipientKey({ ...base, promptType: "cold-email-v55" })).not.toBe(a);
    // A new best workflow re-writes, even when it states the same template + model.
    expect(previewRecipientKey({ ...base, workflowSlug: "sales-cold-email-outreach-nobelium-v6" })).not.toBe(a);
    expect(previewRecipientKey({ ...base, offerId: "o" })).not.toBe(a);
    // A preview stored under an older annotation contract is rewritten, not served.
    expect(previewRecipientKey({ ...base, annotationVersion: "highlights-v2" })).not.toBe(a);
  });
});

describe("buildPreviewContext", () => {
  it("is null without an audience", () => {
    expect(buildPreviewContext(undefined)).toBeNull();
    expect(buildPreviewContext("  ")).toBeNull();
    expect(buildPreviewContext("SaaS founders")).toEqual({ audience: "SaaS founders" });
  });
});

describe("no hardcoded preview template or model", () => {
  const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");

  it("the preview route and its modules name no template type and no model alias", () => {
    for (const file of ["src/routes/preview-email.ts", "src/lib/preview-email.ts", "src/lib/preview-workflow.ts", "src/lib/preview-workflow-client.ts"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/["'`][a-z-]*email-v\d+["'`]/);
      expect(src, file).not.toMatch(/PREVIEW_MODEL|PREVIEW_PROMPT_TYPE|disableThinking: true/);
      for (const alias of ["sonnet", "haiku", "opus", "flash-lite", "deepseek-flash", "glm-pro", "gpt-pro", "fable"]) {
        expect(src, `${file} names ${alias}`).not.toContain(`"${alias}"`);
      }
    }
  });

  it("chat-models carries no preview-only model and chat-service-client no thinking override", () => {
    expect(read("src/lib/chat-models.ts")).not.toContain("PREVIEW_MODEL");
    expect(read("src/lib/chat-service-client.ts")).not.toContain("disableThinking");
  });
});
