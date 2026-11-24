import { Router, Response, type RequestHandler } from "express";
import { AuthenticatedRequest, serviceAuth, serviceAuthRunOptional } from "../middleware/auth.js";
import { CreateVideoRequestSchema, MomentsBodySchema, MomentsRequestBodySchema, TranscriptRequestSchema } from "../schemas.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { assertPublicHost } from "../lib/reels/download.js";
import { ReelsError } from "../lib/reels/errors.js";
import { badRequest, callerIdentity, exactlyOne, holdWhile, sendReelsError, trackingOf, UUID, waitDeadline } from "../lib/reels/http.js";
import { enqueueVideo, requestTranscript } from "../lib/reels/jobs.js";
import { askReelsLlm } from "../lib/reels/llm.js";
import { buildMomentsRequest, readMomentsAnswer } from "../lib/reels/moments.js";
import { toVideoResponse } from "../lib/reels/responses.js";
import { resolveSourceUrl } from "../lib/reels/source-url.js";
import { findHeldVideoBySource, findVideo, findVideoByKey, insertProposal, insertVideo, readTranscript, type VideoRow } from "../lib/reels/store.js";
import { wordsInSpan, type Transcript } from "../lib/reels/transcript.js";

/**
 * Reels, the source side (REELS-1124): download a long recording, transcribe it, pick its moments.
 * No run is opened and nothing is declared here: every row carries the caller's run, and the
 * caller declares its Unit on the stable id each POST answers.
 */
const router = Router();
// auth.js is replaced wholesale by unit-suite mocks: the middleware is read at request time.
const auth: RequestHandler = (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next);
const authRead: RequestHandler = (req, res, next) => serviceAuthRunOptional(req as AuthenticatedRequest, res, next);

/** POST /videos: queue the download of a recording. A source is fetched once per org. */
router.post("/videos", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = CreateVideoRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const body = parsed.data;
  const orgId = req.orgId!;
  try {
    if (body.idempotencyKey) {
      const existing = await findVideoByKey(orgId, body.idempotencyKey);
      if (existing) return res.status(202).json(toVideoResponse(existing));
    }
    const sourceUrl = body.sourceUrl.trim();
    // Refused before anything is stored: not https, or a host that resolves to a private address.
    await assertPublicHost(new URL(resolveSourceUrl(sourceUrl)).hostname);
    if (!body.idempotencyKey) {
      const held = await findHeldVideoBySource(orgId, sourceUrl);
      if (held) return res.status(202).json(toVideoResponse(held));
    }
    let row: VideoRow;
    try {
      row = await insertVideo({ orgId, userId: req.userId!, runId: req.runId!, tracking: trackingOf(req), sourceUrl, idempotencyKey: body.idempotencyKey ?? null });
    } catch (err) {
      const winner = isUniqueViolation(err, "idx_videos_idempotency") && body.idempotencyKey ? await findVideoByKey(orgId, body.idempotencyKey) : undefined;
      if (winner) return res.status(202).json(toVideoResponse(winner));
      throw err;
    }
    enqueueVideo(row.id);
    return res.status(202).json(toVideoResponse(row));
  } catch (err) {
    return sendReelsError(res, err, "POST /videos");
  }
});

router.get("/videos/:id", authRead, async (req: AuthenticatedRequest, res: Response) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(404).json({ error: "Not found" });
  const deadline = waitDeadline(req, res);
  if (deadline === null) return;
  try {
    const first = await findVideo(req.orgId!, id);
    if (!first) return res.status(404).json({ error: "Not found" });
    const row = await holdWhile(req, deadline, first, () => findVideo(req.orgId!, id), (v) => v.status === "queued" || v.status === "downloading");
    if (!row) return;
    return res.status(200).json(toVideoResponse(row));
  } catch (err) {
    return sendReelsError(res, err, "GET /videos/:id");
  }
});

/** POST /videos/:id/transcript: idempotent; chat-service transcribes, a poller here stores the result. */
router.post("/videos/:id/transcript", auth, async (req: AuthenticatedRequest, res: Response) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(404).json({ error: "Not found" });
  const parsed = TranscriptRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const video = await findVideo(req.orgId!, id);
    if (!video) return res.status(404).json({ error: "Not found" });
    const status = await requestTranscript(video, { language: parsed.data.language ?? null, transcriptionId: parsed.data.transcriptionId ?? null }, callerIdentity(req));
    return res.status(202).json({ id: video.id, status });
  } catch (err) {
    return sendReelsError(res, err, "POST /videos/:id/transcript");
  }
});

const seconds = (raw: unknown): number | null | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return typeof raw === "string" && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

router.get("/videos/:id/transcript", authRead, async (req: AuthenticatedRequest, res: Response) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(404).json({ error: "Not found" });
  const from = seconds(req.query.from);
  const to = seconds(req.query.to);
  if (from === null || to === null || (from !== undefined && to !== undefined && to <= from)) {
    return res.status(400).json({ error: "from and to are seconds (numbers ≥ 0), to after from" });
  }
  if (req.query.words !== undefined && req.query.words !== "true" && req.query.words !== "false") {
    return res.status(400).json({ error: "words must be true or false" });
  }
  const withWords = req.query.words !== "false";
  const deadline = waitDeadline(req, res);
  if (deadline === null) return;
  try {
    const first = await findVideo(req.orgId!, id);
    if (!first) return res.status(404).json({ error: "Not found" });
    const video = await holdWhile(req, deadline, first, () => findVideo(req.orgId!, id), (v) => v.transcriptStatus === "queued" || v.transcriptStatus === "transcribing");
    if (!video) return;
    const transcript = video.transcriptStatus === "done" ? await readTranscript(video.id) : null;
    const ranged = from !== undefined || to !== undefined;
    const a = from ?? 0;
    const b = to ?? Number.POSITIVE_INFINITY;
    const segments = transcript ? (ranged ? transcript.segments.filter((s) => s.end > a && s.start < b) : transcript.segments) : [];
    const words = transcript ? (ranged ? wordsInSpan(transcript, a, b) : transcript.words) : [];
    return res.status(200).json({
      id: video.id,
      status: video.transcriptStatus,
      language: video.transcriptLanguage,
      text: transcript ? (ranged ? words.map((w) => w.word).join(" ") : transcript.text) : null,
      wordTimestamps: transcript?.wordTimestamps ?? null,
      durationSeconds: video.durationSeconds,
      segments,
      words: withWords ? words : null,
      error: video.transcriptError,
    });
  } catch (err) {
    return sendReelsError(res, err, "GET /videos/:id/transcript");
  }
});

/** The video and its finished transcript, or the answer already sent (404 / 409). */
async function videoWithTranscript(req: AuthenticatedRequest, res: Response): Promise<{ video: VideoRow; transcript: Transcript } | null> {
  const id = req.params.id;
  const video = UUID.test(id) ? await findVideo(req.orgId!, id) : undefined;
  if (!video) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const transcript = video.transcriptStatus === "done" ? await readTranscript(video.id) : null;
  if (!transcript) throw new ReelsError("TRANSCRIPT_NOT_READY", `The video's transcript is ${video.transcriptStatus}: ask it with POST /videos/${video.id}/transcript and wait for done`, 409);
  return { video, transcript };
}

/** POST /videos/:id/moments/request: the chat-service request, minus the LLM. Spends nothing, stores nothing. */
router.post("/videos/:id/moments/request", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = MomentsRequestBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const found = await videoWithTranscript(req, res);
    if (!found) return;
    return res.json({ request: buildMomentsRequest(found.transcript, parsed.data) });
  } catch (err) {
    return sendReelsError(res, err, "POST /videos/:id/moments/request");
  }
});

/** POST /videos/:id/moments: pick the moments worth cutting, with `model` (we ask) or `completion` (a script asked). */
router.post("/videos/:id/moments", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = MomentsBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const { model, completion, ...params } = parsed.data;
  const one = exactlyOne({ model, completion });
  if ("status" in one) return res.status(one.status).json({ error: one.error, code: one.code });
  try {
    const found = await videoWithTranscript(req, res);
    if (!found) return;
    const request = buildMomentsRequest(found.transcript, params);
    const answer = await askReelsLlm(request, completion ? { completion } : { model: model! }, callerIdentity(req));
    const moments = readMomentsAnswer(answer.json, found.transcript, (m) => console.warn(`[reels] video ${found.video.id} ${m}`));
    const id = await insertProposal({
      orgId: req.orgId!, runId: req.runId!, videoId: found.video.id, kind: "moments", model: answer.model,
      tokensInput: answer.tokensInput, tokensOutput: answer.tokensOutput,
      request: { systemPrompt: request.systemPrompt, message: request.message, by: completion ? { completionRunId: completion.runId } : { model } },
      responseRaw: answer.responseRaw, result: { moments },
    });
    return res.json({ id, model: answer.model, moments });
  } catch (err) {
    return sendReelsError(res, err, "POST /videos/:id/moments", 502);
  }
});

export default router;
