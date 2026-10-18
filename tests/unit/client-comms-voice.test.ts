import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateFromTemplate } from "../../src/lib/chat-service-client.js";
import * as voiceModule from "../../src/lib/client-comms-voice.js";

// tests/setup.ts stubs readClientCommsVoice for every suite; this file reads the real one.
const actual = await vi.importActual<typeof import("../../src/lib/client-comms-voice.js")>(
  "../../src/lib/client-comms-voice.js"
);

const SKILL_V1 = "# How we talk to a person\n- Answer the question they asked, first.";
const SKILL_V2 = `${SKILL_V1}\n- Always end with the word Cheers.`;

const skillResponse = (content: string) =>
  new Response(JSON.stringify({ slug: "client-comms", content, version: 3 }), { status: 200 });

const completeResponse = () =>
  new Response(
    JSON.stringify({
      content: "{}",
      json: { subject: "s", emails: [{ body: "Hi", daysSinceLastStep: 0 }] },
      tokensInput: 1,
      tokensOutput: 1,
      model: "m",
    }),
    { status: 200 }
  );

describe("readClientCommsVoice (real module)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads the client-comms skill from chat-service's internal skills route with the service key", async () => {
    fetchSpy.mockResolvedValueOnce(skillResponse(SKILL_V1));
    expect(await actual.readClientCommsVoice()).toBe(SKILL_V1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/internal\/skills\/client-comms$/);
    expect((init as RequestInit).headers).toHaveProperty("X-Api-Key");
  });

  it("is read live: every call fetches again, so an edit reaches the next email", async () => {
    fetchSpy.mockResolvedValueOnce(skillResponse(SKILL_V1)).mockResolvedValueOnce(skillResponse(SKILL_V2));
    expect(await actual.readClientCommsVoice()).toBe(SKILL_V1);
    expect(await actual.readClientCommsVoice()).toBe(SKILL_V2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fails loud on a non-2xx answer, never a default voice", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "No skill" }), { status: 404 }));
    await expect(actual.readClientCommsVoice()).rejects.toBeInstanceOf(actual.ClientCommsVoiceError);
  });

  it("fails loud on an empty skill", async () => {
    fetchSpy.mockResolvedValueOnce(skillResponse("   "));
    await expect(actual.readClientCommsVoice()).rejects.toThrow(/has no content/);
  });

  it("fails loud when chat-service cannot be reached", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(actual.readClientCommsVoice()).rejects.toThrow(/client-comms unreadable/);
  });
});

describe("generateFromTemplate writes in our voice", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  async function systemPromptWithVoice(voice: string) {
    vi.mocked(voiceModule.readClientCommsVoice).mockResolvedValueOnce(voice);
    fetchSpy.mockResolvedValueOnce(completeResponse());
    await generateFromTemplate(
      { promptTemplate: "Write a cold pitch.", variables: {}, instruction: "Ask ONE open question." },
      { orgId: "o", userId: "u", runId: "r" }
    );
    return JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string).systemPrompt as string;
  }

  it("puts the skill verbatim in the system prompt, before the campaign instruction (WHAT stays last)", async () => {
    const sp = await systemPromptWithVoice(SKILL_V1);
    expect(sp).toContain(actual.buildClientCommsVoiceDirective(SKILL_V1));
    expect(sp.indexOf("Ask ONE open question.")).toBeGreaterThan(sp.indexOf(SKILL_V1));
  });

  it("a one-line edit of the skill reaches the next generation", async () => {
    const before = await systemPromptWithVoice(SKILL_V1);
    const after = await systemPromptWithVoice(SKILL_V2);
    expect(before).not.toContain("Always end with the word Cheers.");
    expect(after).toContain("Always end with the word Cheers.");
  });

  it("an unreadable skill refuses the generation before any completion is paid", async () => {
    vi.mocked(voiceModule.readClientCommsVoice).mockRejectedValueOnce(
      new actual.ClientCommsVoiceError("chat-service skill client-comms unreadable: 503 - down")
    );
    await expect(
      generateFromTemplate({ promptTemplate: "Write.", variables: {} }, { orgId: "o", userId: "u", runId: "r" })
    ).rejects.toThrow(/client-comms unreadable/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
