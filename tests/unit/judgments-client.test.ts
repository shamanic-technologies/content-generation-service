import { describe, it, expect, vi, afterEach } from "vitest";
import { askJudgments } from "../../src/lib/judgments-client.js";
import {
  PLATFORM_PROMPT_REGISTRATION_SUPPORT,
  TEMPLATE_DYNASTY_CREATE_SUPPORT,
  TEMPLATE_DYNASTY_VERSION_SUPPORT,
  SUPPORT_FUNCTIONS,
} from "../../src/lib/platform-judgment-support.js";

// PLATFORM-CALLER-RUN-1024: every platform call states whose work it is,
// exactly one of x-run-id (our run) or support (one function + reason).
function capture() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ model: "jev", answers: {}, usage: { inputTokens: 1, outputTokens: 0 } }), { status: 200 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("askJudgments: whose work", () => {
  const body = { state: "s", questions: {} };

  it("platform tier sends support in the body and never an x-run-id", async () => {
    const calls = capture();
    await askJudgments(body, { mode: "platform", support: TEMPLATE_DYNASTY_VERSION_SUPPORT });
    expect(calls[0].url).toMatch(/\/internal\/platform-judgments$/);
    expect(calls[0].body.support).toEqual(TEMPLATE_DYNASTY_VERSION_SUPPORT);
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase())).not.toContain("x-run-id");
  });

  it("org tier sends its run and no support", async () => {
    const calls = capture();
    const runId = "44444444-4444-4444-4444-444444444444";
    await askJudgments(body, { mode: "org", tracking: { orgId: "o", userId: "u", runId } as any });
    expect(calls[0].url).toMatch(/\/orgs\/judgments$/);
    expect(calls[0].headers["x-run-id"]).toBe(runId);
    expect(calls[0].body.support).toBeUndefined();
  });

  it("each platform call site declares platform_llm with a plain reason", () => {
    for (const s of [PLATFORM_PROMPT_REGISTRATION_SUPPORT, TEMPLATE_DYNASTY_CREATE_SUPPORT, TEMPLATE_DYNASTY_VERSION_SUPPORT]) {
      expect(s.kind).toBe("platform_llm");
      expect(SUPPORT_FUNCTIONS).toContain(s.kind);
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.reason.length).toBeLessThanOrEqual(2000);
    }
  });
});
