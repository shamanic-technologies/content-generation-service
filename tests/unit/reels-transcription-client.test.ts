import { describe, it, expect, vi, afterEach } from "vitest";
import { readTranscription, startTranscription, TranscriptionRefusedError } from "../../src/lib/reels/transcription-client.js";
import { normalizeTranscript } from "../../src/lib/reels/transcript.js";

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("chat-service media transcriptions client", () => {
  it("starts a job with the recording's public url, the language hint and an idempotency key, under the caller's run", async () => {
    const fetchMock = vi.fn(async () => json(202, { id: "tr-1", status: "downloading" }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await startTranscription({ url: "https://files.example.com/interview.mp4", language: "fr", idempotencyKey: "k-1" }, identity);
    expect(out).toEqual({ ref: "tr-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/orgs\/media-transcriptions$/);
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://files.example.com/interview.mp4", idempotencyKey: "k-1", language: "fr" });
    const headers = init.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-run-id"]).toBe("run-1");
  });

  it("a 4xx is a refusal that a retry cannot fix; a 5xx is an error retried at the next tick", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(422, { error: "not media", code: "not_media" })));
    await expect(startTranscription({ url: "https://x.example.com/a", idempotencyKey: "k" }, identity)).rejects.toBeInstanceOf(TranscriptionRefusedError);
    vi.stubGlobal("fetch", vi.fn(async () => json(503, { code: "box_transcriber_not_configured" })));
    const err = await startTranscription({ url: "https://x.example.com/a", idempotencyKey: "k" }, identity).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionRefusedError);
  });

  it("reads running until completed, then the segments and words in one more read", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return json(200, { id: "tr-1", status: "transcribing" });
      if (calls.length === 2) return json(200, { id: "tr-1", status: "completed", language: "en" });
      return json(200, {
        id: "tr-1", status: "completed", language: "en", text: "Hello there. General Kenobi.",
        segments: [{ startSeconds: 0, endSeconds: 1.2, text: "Hello there." }, { startSeconds: 1.4, endSeconds: 2.6, text: "General Kenobi." }],
        words: [
          { startSeconds: 0, endSeconds: 0.5, word: "Hello", probability: 0.99 }, { startSeconds: 0.5, endSeconds: 1.2, word: "there.", probability: 0.98 },
          { startSeconds: 1.4, endSeconds: 2, word: "General", probability: 0.9 }, { startSeconds: 2, endSeconds: 2.6, word: "Kenobi.", probability: 0.9 },
        ],
      });
    }));
    expect(await readTranscription("tr-1", identity)).toEqual({ status: "running" });
    const done = await readTranscription("tr-1", identity);
    expect(done.status).toBe("done");
    expect(calls[2]).toMatch(/\/orgs\/media-transcriptions\/tr-1\?include=segments,words$/);
    const transcript = normalizeTranscript(done.raw);
    expect(transcript.wordTimestamps).toBe("model");
    expect(transcript.language).toBe("en");
    expect(transcript.segments).toEqual([{ index: 0, start: 0, end: 1.2, text: "Hello there." }, { index: 1, start: 1.4, end: 2.6, text: "General Kenobi." }]);
    expect(transcript.words[2]).toEqual({ start: 1.4, end: 2, word: "General" });
  });

  it("a failed job names its code and message; an unknown id is a failure, never a wait", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { status: "failed", error: { code: "interrupted", message: "the box restarted" } })));
    expect(await readTranscription("tr-1", identity)).toEqual({ status: "failed", error: "interrupted: the box restarted" });
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "Not found" })));
    expect((await readTranscription("tr-9", identity)).status).toBe("failed");
  });
});
