import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ReelsError } from "../../src/lib/reels/errors.js";
import { buildMomentsRequest, readMomentsAnswer } from "../../src/lib/reels/moments.js";
import {
  buildExternalHookRequest, buildInternalHookRequest, hookLine, readExternalHookAnswer, readInternalHookAnswer, sampleHooks, wordLines,
  type LibraryHook,
} from "../../src/lib/reels/hooks.js";
import {
  hookId, isOcrNoise, parseTikTokPage, parseViralHooksMarkdown, selectTikTokHooks, tiktokHooksFinetune, tiktokPageUrl, unquote,
  TIKTOK_KEEP, TIKTOK_PAGES,
} from "../../src/lib/reels/hook-sources.js";
import { askReelsLlm, ReelsInsufficientCreditsError } from "../../src/lib/reels/llm.js";
import { normalizeTranscript } from "../../src/lib/reels/transcript.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const errorCode = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof ReelsError ? `${e.code}:${e.httpStatus}` : String(e); }
  return "did not throw";
};

const transcript = normalizeTranscript({
  language: "en",
  segments: [
    { start: 0, end: 4, text: "Welcome back everyone.", words: [{ start: 0.2, end: 1, word: "Welcome" }, { start: 1, end: 2, word: "back" }, { start: 2, end: 3.8, word: "everyone." }] },
    { start: 221.2, end: 227.9, text: "We lost every client in a week.", words: [{ start: 221.3, end: 222, word: "We" }, { start: 222, end: 223, word: "lost" }, { start: 223, end: 224, word: "every" }, { start: 224, end: 225, word: "client" }, { start: 225, end: 226, word: "in" }, { start: 226, end: 226.5, word: "a" }, { start: 226.5, end: 227.8, word: "week." }] },
    { start: 228, end: 240, text: "And that saved the company.", words: [{ start: 228.1, end: 229, word: "And" }, { start: 229, end: 230, word: "that" }, { start: 230, end: 232, word: "saved" }, { start: 232, end: 233, word: "the" }, { start: 233, end: 239.5, word: "company." }] },
  ],
});

describe("reels moments", () => {
  it("builds a request with the same keys as the thread writer's, the transcript as numbered lines", () => {
    const r = buildMomentsRequest(transcript, { count: 3, minSeconds: 15, maxSeconds: 45 });
    expect(Object.keys(r).sort()).toEqual(["maxTokens", "message", "responseFormat", "responseSchema", "strictResponseSchema", "systemPrompt"]);
    expect(r.responseFormat).toBe("json");
    expect(r.message.split("\n")[1]).toBe("[1] 03:41.2-03:47.9 We lost every client in a week.");
    expect(r.systemPrompt).toContain("Pick the 3 strongest moments");
    expect(r.systemPrompt).toContain("between 15 and 45 seconds");
    expect(r.systemPrompt).toContain("self-contained");
    expect(r.systemPrompt).not.toContain("BRIEF");
  });

  it("defaults to 5 moments of 20 to 60 s, and carries the campaign brief when given", () => {
    const r = buildMomentsRequest(transcript, { brief: "Only moments about pricing." });
    expect(r.systemPrompt).toContain("Pick the 5 strongest moments");
    expect(r.systemPrompt).toContain("between 20 and 60 seconds");
    expect(r.systemPrompt).toContain("Only moments about pricing.");
    expect(r.systemPrompt.indexOf("Only moments about pricing.")).toBeLessThan(r.systemPrompt.indexOf("OUTPUT:"));
  });

  it("makes the strict schema strict at every object level, the permissive one untouched", () => {
    const r = buildMomentsRequest(transcript) as unknown as { responseSchema: any; strictResponseSchema: any };
    expect(r.strictResponseSchema.additionalProperties).toBe(false);
    expect(r.strictResponseSchema.properties.moments.items.additionalProperties).toBe(false);
    expect(r.responseSchema.additionalProperties).toBeUndefined();
    expect(r.responseSchema.properties.moments.items.additionalProperties).toBeUndefined();
  });

  it("maps segment indexes to source seconds and drops moments naming missing segments", () => {
    const log = vi.fn();
    const moments = readMomentsAnswer(
      { moments: [{ startSegment: 1, endSegment: 2, title: " The week ", why: "stakes", quote: "We lost every client in a week." }, { startSegment: 2, endSegment: 9, title: "x", why: "y", quote: "z" }, { startSegment: "1", endSegment: 1, title: "t" }] },
      transcript, log,
    );
    expect(moments).toEqual([
      { start: 221.2, end: 240, durationSeconds: 18.8, title: "The week", why: "stakes", quote: "We lost every client in a week." },
      { start: 221.2, end: 227.9, durationSeconds: 6.7, title: "t", why: "", quote: "" },
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("2..9");
  });

  it("answers NO_MOMENTS (502) when nothing usable came back", () => {
    expect(errorCode(() => readMomentsAnswer({ moments: [{ startSegment: 40, endSegment: 41 }] }, transcript))).toBe("NO_MOMENTS:502");
    expect(errorCode(() => readMomentsAnswer({}, transcript))).toBe("NO_MOMENTS:502");
    expect(errorCode(() => readMomentsAnswer(null, transcript))).toBe("NO_MOMENTS:502");
  });
});

const clipWords = transcript.words.filter((w) => w.start >= 221);

describe("reels internal hook", () => {
  it("lists the clip's words as index|seconds from the clip's start|word", () => {
    expect(wordLines(clipWords, 221.2).split("\n").slice(0, 3)).toEqual(["0|0.1|We", "1|0.8|lost", "2|1.8|every"]);
    const r = buildInternalHookRequest(clipWords, 221.2, { maxSeconds: 4 });
    expect(r.message.split("\n")).toHaveLength(12);
    expect(r.systemPrompt).toContain("between 1.5 and 4 seconds");
    expect(r.systemPrompt).toContain("later than the clip's first 5 seconds");
    expect(buildInternalHookRequest(clipWords, 221.2).systemPrompt).toContain("between 1.5 and 3 seconds");
  });

  it("reads the chosen words as a source span, with the quote from the transcript", () => {
    expect(readInternalHookAnswer({ startWord: 1, endWord: 3, quote: "whatever the model says", why: " bold " }, clipWords)).toEqual({ start: 222, end: 225, quote: "lost every client", why: "bold" });
  });

  it("refuses word indexes that do not exist: HOOK_UNREADABLE 502", () => {
    for (const bad of [{ startWord: 3, endWord: 1 }, { startWord: -1, endWord: 2 }, { startWord: 0, endWord: 12 }, { startWord: 1.5, endWord: 2 }, {}, null]) {
      expect(errorCode(() => readInternalHookAnswer(bad, clipWords))).toBe("HOOK_UNREADABLE:502");
    }
  });
});

const lib = (id: string, source: string, template: string, views?: number): LibraryHook => ({ id, source, sourceUrl: "https://example.com", category: null, template, evidence: views === undefined ? null : { views } });

describe("reels external hook", () => {
  const templates = Array.from({ length: 100 }, (_, i) => lib(`viral-hooks-skill:${String(i).padStart(3, "0")}`, "viral-hooks-skill", `Stop [thing ${i}]`));
  const verbatim = Array.from({ length: 300 }, (_, i) => lib(`tiktok-hooks-finetune:${String(i).padStart(3, "0")}`, "tiktok-hooks-finetune", `hook number ${i}`, 1000 + i));

  it("samples every template + 50 verbatim hooks, the same for the same clip, different across clips", () => {
    const a = sampleHooks([...verbatim, ...templates], "clip-a");
    expect(a).toHaveLength(150);
    expect(a.filter((h) => h.source === "viral-hooks-skill")).toHaveLength(100);
    expect(a.filter((h) => h.source === "tiktok-hooks-finetune")).toHaveLength(50);
    expect(sampleHooks([...templates, ...verbatim].reverse(), "clip-a").map((h) => h.id)).toEqual(a.map((h) => h.id));
    expect(sampleHooks([...templates, ...verbatim], "clip-b").map((h) => h.id)).not.toEqual(a.map((h) => h.id));
    // a small library is shown whole
    expect(sampleHooks([...templates.slice(0, 3), ...verbatim.slice(0, 4)], "clip-a")).toHaveLength(7);
  });

  it("shows each line as id | template | views when known", () => {
    expect(hookLine(lib("a:1", "viral-hooks-skill", "Nobody talks about [thing] | really"))).toBe("a:1 | Nobody talks about [thing] / really");
    expect(hookLine(lib("b:2", "tiktok-hooks-finetune", "me getting FREE stuff", 1400000))).toBe("b:2 | me getting FREE stuff | 1400000 views");
  });

  it("explains the game: one library line, blanks filled, verbatim adapted, true to the clip, ≤ 10 words", () => {
    const r = buildExternalHookRequest("We lost every client in a week and that saved the company.", [templates[0], verbatim[0]], { brief: "Speak to founders." });
    expect(r.message).toBe("We lost every client in a week and that saved the company.");
    expect(r.systemPrompt).toContain("[blanks] is a template");
    expect(r.systemPrompt).toContain("keeping its structure");
    expect(r.systemPrompt).toContain("At most 10 words");
    expect(r.systemPrompt).toContain("viral-hooks-skill:000 | Stop [thing 0]");
    expect(r.systemPrompt).toContain("tiktok-hooks-finetune:000 | hook number 0 | 1000 views");
    expect(r.systemPrompt).toContain("Speak to founders.");
  });

  it("reads the chosen line, dashes stripped; an unknown hook id or no text is HOOK_UNREADABLE 502", () => {
    const find = (id: string) => [templates[0]].find((h) => h.id === id);
    expect(readExternalHookAnswer({ hookId: templates[0].id, text: " Stop hiring — start firing ", why: "w" }, find)).toEqual({ hook: templates[0], text: "Stop hiring, start firing", why: "w" });
    expect(errorCode(() => readExternalHookAnswer({ hookId: "made-up", text: "x" }, find))).toBe("HOOK_UNREADABLE:502");
    expect(errorCode(() => readExternalHookAnswer({ hookId: templates[0].id, text: "  " }, find))).toBe("HOOK_UNREADABLE:502");
    expect(errorCode(() => readExternalHookAnswer(null, find))).toBe("HOOK_UNREADABLE:502");
  });
});

describe("reels hook sources", () => {
  it("gives a line a stable id per source", () => {
    expect(hookId("viral-hooks-skill", "Stop [x]")).toMatch(/^viral-hooks-skill:[0-9a-f]{12}$/);
    expect(hookId("a", "Stop [x]")).toBe(hookId("a", "Stop [x]"));
    expect(hookId("a", "Stop [x]").split(":")[1]).toBe(hookId("b", "Stop [x]").split(":")[1]);
    expect(unquote('"Upper/Lower is better"')).toBe("Upper/Lower is better");
    expect(unquote('"I eat" and "me too"')).toBe('"I eat" and "me too"');
  });

  it("parses the viral-hooks-skill markdown tables under their category headings", () => {
    const hooks = parseViralHooksMarkdown(fixture("viral-hooks-database-sample.md"));
    expect(hooks).toHaveLength(20);
    expect(hooks[0]).toEqual({
      template: "Nobody talks about [unexpected thing] in [niche]",
      category: "Curiosity Gap",
      evidence: { example: "Nobody talks about why your Reels flop after 3am posts", platform: "All" },
    });
    expect(hooks[10]).toMatchObject({ template: "Stop [common advice everyone gives]", category: "Contrarian / Pattern-Interrupt" });
    expect(new Set(hooks.map((h) => h.category))).toEqual(new Set(["Curiosity Gap", "Contrarian / Pattern-Interrupt"]));
    // header rows, separators and prose are never hooks
    expect(hooks.some((h) => /Formula|---|Why it works/.test(h.template))).toBe(false);
    expect(parseViralHooksMarkdown("# nothing here\n| a | b |")).toEqual([]);
  });

  it("keeps of a TikTok page only English hooks of 3..14 words that beat their account 10x, without handle or URL", () => {
    const body = fixture("tiktok-hooks-rows-sample.json");
    const hooks = parseTikTokPage(body);
    const rows = (JSON.parse(body) as { rows: Array<{ row: Record<string, any> }> }).rows.map((r) => r.row);
    const expected = rows.filter((r) => r.text_hook_lang === "en" && r.outlier_multiplier >= 10 && (() => { const n = unquote(r.text_hook).split(" ").length; return n >= 3 && n <= 14; })());
    expect(hooks).toHaveLength(expected.length);
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.length).toBeLessThan(rows.length);
    const challengers = hooks.find((h) => h.template === "Me when I listen to the Challengers soundtrack")!;
    expect(challengers).toEqual({ template: "Me when I listen to the Challengers soundtrack", category: expect.any(String), evidence: { views: 2800000, likes: expect.any(Number), shares: expect.any(Number), outlierMultiplier: 55.78 } });
    // a quoted hook loses its wrapping quotes; nothing of the creator leaves the parse
    expect(unquote('"Upper/Lower is better"')).toBe("Upper/Lower is better");
    // that one only doubled its account's usual views: not kept
    expect(hooks.some((h) => h.template.includes("Upper/Lower"))).toBe(false);
    expect(JSON.stringify(hooks)).not.toMatch(/tiktok\.com|username|redacted|ad_link/);
    expect(() => parseTikTokPage('{"error":"nope"}')).toThrow(/rows/);
  });

  it("drops what the dataset's vision model said about the picture or read off a lock screen, keeps real lines", () => {
    for (const noise of [
      "There is no text or emojis on top of the image.", "The image does not contain any text.", "There is no text in this image.",
      'The text in the image is: "Look in the mirror"', "Chillguyday, May 12 75:04", "11:11 88:11 22:22",
      "Customize Wallpaper Tuesday, Feb 14 75:16 Decembday, June 15 44:21 Lock Screen Home Screen",
    ]) expect(isOcrNoise(noise), noise).toBe(true);
    for (const line of [
      "How students sleep knowing they have 10 assignments due by 11:59pm", "First day as a housekeeper... I wasn't ready for THIS",
      "Remember this scene?", "MY 5-9 AFTER MY 9-5", "Would you try this?",
    ]) expect(isOcrNoise(line), line).toBe(false);
    const page = JSON.stringify({ rows: [
      { row: { text_hook: "There is no text or emojis on top of the image.", text_hook_lang: "en", views: "37600000", outlier_multiplier: "23.5" } },
      { row: { text_hook: "Remember this scene today?", text_hook_lang: "en", views: "900", outlier_multiplier: "12" } },
    ] });
    expect(parseTikTokPage(page).map((h) => h.template)).toEqual(["Remember this scene today?"]);
  });

  it("dedupes on the normalized text and keeps the most viewed", () => {
    const h = (template: string, views: number) => ({ template, evidence: { views } });
    const kept = selectTikTokHooks([h("Wait for it...", 10), h("wait for it", 500), h("WAIT, for it!", 20), h("another hook here", 50)]);
    expect(kept.map((k) => [k.template, k.evidence!.views])).toEqual([["wait for it", 500], ["another hook here", 50]]);
    expect(selectTikTokHooks(Array.from({ length: 400 }, (_, i) => h(`hook number ${i}`, i)))).toHaveLength(TIKTOK_KEEP);
  });

  it("reads a bounded number of pages one after the other; a page failing 3 times stops the read and keeps the rest", async () => {
    const page = fixture("tiktok-hooks-rows-sample.json");
    const calls: string[] = [];
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const all = await tiktokHooksFinetune.read!(async (url) => { calls.push(url); return page; }, { sleep, log });
    expect(calls).toHaveLength(TIKTOK_PAGES);
    expect(calls[0]).toBe(tiktokPageUrl(0));
    expect(calls[1]).toContain("offset=100&length=100");
    expect(all.length).toBe(parseTikTokPage(page).length); // the same page 40 times dedupes to itself
    expect(log).not.toHaveBeenCalled();

    calls.length = 0;
    const partial = await tiktokHooksFinetune.read!(async (url) => { calls.push(url); if (url === tiktokPageUrl(2)) throw new Error("503"); return page; }, { sleep, log });
    expect(calls.filter((u) => u === tiktokPageUrl(2))).toHaveLength(3);
    expect(calls).toHaveLength(5); // pages 0, 1, then page 2 three times: nothing after it
    expect(partial.length).toBeGreaterThan(0);
    expect(log.mock.calls[0][0]).toMatch(/page 2 FAILED 3 times.*keeping the 2 page/);

    await expect(tiktokHooksFinetune.read!(async () => { throw new Error("down"); }, { sleep, log })).rejects.toThrow(/no page/);
  });
});

describe("reels LLM helper", () => {
  afterEach(() => vi.unstubAllGlobals());
  const request = buildMomentsRequest(transcript);
  const identity = { orgId: "org-1", userId: "user-1", runId: "caller-run", campaignId: "camp-1" };
  const answer = { json: { moments: [] }, model: "claude-sonnet-5-5", tokensInput: 1200, tokensOutput: 80 };

  it("calls chat-service /complete under the caller's run, strict schema for anthropic", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await askReelsLlm(request, { model: "claude-sonnet" }, identity);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/complete$/);
    expect(init.headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "caller-run", "x-campaign-id": "camp-1" });
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ message: request.message, systemPrompt: request.systemPrompt, responseFormat: "json", responseSchema: request.strictResponseSchema, maxTokens: request.maxTokens, provider: "anthropic", model: "claude-sonnet" });
    expect(result).toMatchObject({ json: { moments: [] }, model: "claude-sonnet-5-5", tokensInput: 1200, tokensOutput: 80 });
    expect(result.request).toEqual(sent);
  });

  it("sends the permissive schema to every other provider", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await askReelsLlm(request, { model: "gemini-pro" }, identity);
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.provider).toBe("google");
    expect(sent.responseSchema).toEqual(request.responseSchema);
  });

  it("passes a 402 through and names any other failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ balance_cents: 3, required_cents: 40 }), { status: 402 })));
    await expect(askReelsLlm(request, { model: "claude-sonnet" }, identity)).rejects.toMatchObject({ name: "ReelsInsufficientCreditsError", balance_cents: 3, required_cents: 40 });
    expect(new ReelsInsufficientCreditsError(1, 2)).toBeInstanceOf(Error);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(askReelsLlm(request, { model: "claude-sonnet" }, identity)).rejects.toThrow(/provider 'anthropic' model 'claude-sonnet': 500 - boom/);
  });

  it("refuses an unknown model before any call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(askReelsLlm(request, { model: "not-a-model" }, identity)).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a completion a script handed back without calling anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await askReelsLlm(request, { completion: { request: { systemPrompt: "as sent", model: "glm" }, answer, runId: "script-run" } }, identity);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ json: { moments: [] }, model: "claude-sonnet-5-5", tokensInput: 1200, request: { systemPrompt: "as sent", model: "glm" } });
  });
});
