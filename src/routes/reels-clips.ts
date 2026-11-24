import { Router, Response, type RequestHandler } from "express";
import { AuthenticatedRequest, serviceAuth, serviceAuthRunOptional } from "../middleware/auth.js";
import {
  CreateClipRequestSchema, ExternalHookBodySchema, ExternalHookRequestBodySchema, HOOK_LIBRARY_MAX_LIMIT,
  InternalHookBodySchema, InternalHookRequestBodySchema,
} from "../schemas.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { cleanHookLine } from "../lib/reels/captions-ass.js";
import { ReelsError } from "../lib/reels/errors.js";
import { refreshHookLibrary } from "../lib/reels/hook-library.js";
import {
  buildExternalHookRequest, buildInternalHookRequest, HOOK_SECONDS, readExternalHookAnswer, readInternalHookAnswer, sampleHooks, type LibraryHook,
} from "../lib/reels/hooks.js";
import { badRequest, callerIdentity, exactlyOne, holdWhile, sendReelsError, trackingOf, UUID, waitDeadline } from "../lib/reels/http.js";
import { enqueueClip, type ExternalHookData, type InternalHookData } from "../lib/reels/jobs.js";
import { askReelsLlm } from "../lib/reels/llm.js";
import { assertPublicMediaBase, newToken } from "../lib/reels/media.js";
import { toClipResponse } from "../lib/reels/responses.js";
import {
  attachProposalToClip, findClip, findClipByKey, findHook, findVideo, insertClip, insertProposal, listActiveHooks, readTranscript,
  type ClipRow, type NewClip,
} from "../lib/reels/store.js";
import { textOfSpan, wordsInSpan, type TranscriptWord } from "../lib/reels/transcript.js";

/**
 * Reels, the clip side (REELS-1124): cut a span into a vertical clip, add a hook to a clip (each
 * hook = a NEW clip row, the parent untouched), read the hook library. No run is opened and
 * nothing is declared here: the caller declares its Unit on the clip id each POST answers.
 */
const router = Router();
// auth.js is replaced wholesale by unit-suite mocks: the middleware is read at request time.
const auth: RequestHandler = (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next);
const authRead: RequestHandler = (req, res, next) => serviceAuthRunOptional(req as AuthenticatedRequest, res, next);

export const CLIP_MIN_SECONDS = 3;
export const CLIP_MAX_SECONDS = 180;
/** An explicit internal hook span (a human chose it). */
const HOOK_SPAN_SECONDS = { min: 0.5, max: 10 };

async function clipText(row: ClipRow): Promise<string | null> {
  const transcript = await readTranscript(row.videoId);
  return transcript ? textOfSpan(transcript, row.startSeconds, row.endSeconds) : null;
}

/** Stores the clip; a concurrent POST with the same key answers the winner. */
async function storeClip(orgId: string, values: NewClip): Promise<{ row: ClipRow; created: boolean }> {
  try {
    return { row: await insertClip(values), created: true };
  } catch (err) {
    const winner = isUniqueViolation(err, "idx_video_clips_idempotency") && values.idempotencyKey ? await findClipByKey(orgId, values.idempotencyKey) : undefined;
    if (winner) return { row: winner, created: false };
    throw err;
  }
}

/** POST /video-clips: queue the render of a cut. */
router.post("/video-clips", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = CreateClipRequestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const body = parsed.data;
  const orgId = req.orgId!;
  try {
    assertPublicMediaBase();
    if (body.idempotencyKey) {
      const existing = await findClipByKey(orgId, body.idempotencyKey);
      if (existing) return res.status(202).json(toClipResponse(existing));
    }
    const video = await findVideo(orgId, body.videoId);
    if (!video) return res.status(404).json({ error: "No video with this id for this org" });
    if (video.status !== "ready") throw new ReelsError("VIDEO_NOT_READY", `The video is ${video.status}: a clip can be cut once it is ready`, 409);
    if (video.sourceDeletedAt) throw new ReelsError("SOURCE_EXPIRED", "The source video passed its retention: its file is deleted, no new clip can be cut from it", 410);
    const length = body.end - body.start;
    const duration = video.durationSeconds ?? 0;
    if (!(length >= CLIP_MIN_SECONDS && length <= CLIP_MAX_SECONDS) || body.end > duration + 0.05) {
      throw new ReelsError("CLIP_RANGE_INVALID", `A clip lasts ${CLIP_MIN_SECONDS} to ${CLIP_MAX_SECONDS} s inside the video (0 to ${duration.toFixed(2)} s); got ${body.start} to ${body.end}`, 400);
    }
    const captions = body.captions ?? true;
    if (captions && video.transcriptStatus !== "done") {
      throw new ReelsError("TRANSCRIPT_NOT_READY", `Captions need the video's transcript and it is ${video.transcriptStatus}: POST /videos/${video.id}/transcript first, or send captions: false`, 409);
    }
    const { row, created } = await storeClip(orgId, {
      orgId, userId: req.userId!, runId: req.runId!, tracking: trackingOf(req), videoId: video.id, parentClipId: null, kind: "cut",
      startSeconds: body.start, endSeconds: Math.min(body.end, duration), layout: body.layout ?? "fit_blur", cropX: body.cropX ?? 0.5, captions,
      hook: null, idempotencyKey: body.idempotencyKey ?? null, token: newToken(),
    });
    if (created) enqueueClip(row.id);
    return res.status(202).json(toClipResponse(row));
  } catch (err) {
    return sendReelsError(res, err, "POST /video-clips");
  }
});

router.get("/video-clips/:id", authRead, async (req: AuthenticatedRequest, res: Response) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(404).json({ error: "Not found" });
  const deadline = waitDeadline(req, res);
  if (deadline === null) return;
  try {
    const first = await findClip(req.orgId!, id);
    if (!first) return res.status(404).json({ error: "Not found" });
    const row = await holdWhile(req, deadline, first, () => findClip(req.orgId!, id), (c) => c.status === "queued" || c.status === "rendering");
    if (!row) return;
    return res.status(200).json(toClipResponse(row, await clipText(row)));
  } catch (err) {
    return sendReelsError(res, err, "GET /video-clips/:id");
  }
});

// --------------------------------------------------------------------------- hooks

/** The clip a hook is added to, rendered and still on disk; null = 404 already answered. */
async function hookParent(req: AuthenticatedRequest, res: Response): Promise<ClipRow | null> {
  const id = req.params.id;
  const clip = UUID.test(id) ? await findClip(req.orgId!, id) : undefined;
  if (!clip) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (clip.status !== "done") throw new ReelsError("CLIP_NOT_READY", `The clip is ${clip.status}: a hook is added to a rendered clip`, 409);
  if (clip.fileDeletedAt) throw new ReelsError("CLIP_EXPIRED", "The clip passed its retention: its file is deleted", 410);
  return clip;
}

/** The words spoken in the clip's main cut (409 when the video has no transcript or the span no word). */
async function clipWords(clip: ClipRow): Promise<TranscriptWord[]> {
  const transcript = await readTranscript(clip.videoId);
  const words = transcript ? wordsInSpan(transcript, clip.startSeconds, clip.endSeconds) : [];
  if (!words.length) {
    throw new ReelsError("TRANSCRIPT_NOT_READY", transcript ? "No word is spoken in this clip: an LLM has nothing to choose a hook from" : "Choosing a hook needs the video's transcript, and it has none", 409);
  }
  return words;
}

async function sourceHeld(req: AuthenticatedRequest, clip: ClipRow) {
  const video = await findVideo(req.orgId!, clip.videoId);
  if (!video || video.sourceDeletedAt) throw new ReelsError("SOURCE_EXPIRED", "An internal hook is cut from the source video, and it passed its retention: its file is deleted", 410);
  return video;
}

/** The hooked clip row: the parent's cut, layout and captions; its own token and hook. */
function hookedClip(req: AuthenticatedRequest, parent: ClipRow, hook: InternalHookData | ExternalHookData, idempotencyKey: string | undefined): NewClip {
  return {
    orgId: req.orgId!, userId: req.userId!, runId: req.runId!, tracking: trackingOf(req), videoId: parent.videoId, parentClipId: parent.id, kind: "hooked",
    startSeconds: parent.startSeconds, endSeconds: parent.endSeconds, layout: parent.layout, cropX: parent.cropX, captions: parent.captions,
    hook, idempotencyKey: idempotencyKey ?? null, token: newToken(),
  };
}

/** POST /video-clips/:id/internal-hook/request: the chat-service request, minus the LLM. */
router.post("/video-clips/:id/internal-hook/request", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = InternalHookRequestBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const clip = await hookParent(req, res);
    if (!clip) return;
    return res.json({ request: buildInternalHookRequest(await clipWords(clip), clip.startSeconds, parsed.data) });
  } catch (err) {
    return sendReelsError(res, err, "POST /video-clips/:id/internal-hook/request");
  }
});

/** POST /video-clips/:id/internal-hook: a NEW clip = the chosen seconds of the source, then the clip. */
router.post("/video-clips/:id/internal-hook", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = InternalHookBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const { model, completion, span, idempotencyKey, ...params } = parsed.data;
  const one = exactlyOne({ model, completion, span });
  if ("status" in one) return res.status(one.status).json({ error: one.error, code: one.code });
  try {
    assertPublicMediaBase();
    if (idempotencyKey) {
      const existing = await findClipByKey(req.orgId!, idempotencyKey);
      if (existing) return res.status(202).json(toClipResponse(existing));
    }
    const clip = await hookParent(req, res);
    if (!clip) return;
    const video = await sourceHeld(req, clip);

    let hook: InternalHookData;
    if (span) {
      const length = span.end - span.start;
      if (!(length >= HOOK_SPAN_SECONDS.min && length <= HOOK_SPAN_SECONDS.max) || span.end > (video.durationSeconds ?? 0) + 0.05) {
        throw new ReelsError("CLIP_RANGE_INVALID", `A hook span lasts ${HOOK_SPAN_SECONDS.min} to ${HOOK_SPAN_SECONDS.max} s inside the source video (0 to ${(video.durationSeconds ?? 0).toFixed(2)} s); got ${span.start} to ${span.end}`, 400);
      }
      hook = { type: "internal", start: span.start, end: span.end, quote: "", why: "", proposalId: null };
      const transcript = await readTranscript(clip.videoId);
      if (transcript) hook.quote = textOfSpan(transcript, span.start, span.end);
    } else {
      const words = await clipWords(clip);
      const request = buildInternalHookRequest(words, clip.startSeconds, params);
      const answer = await askReelsLlm(request, completion ? { completion } : { model: model! }, callerIdentity(req));
      const choice = readInternalHookAnswer(answer.json, words);
      const proposalId = await insertProposal({
        orgId: req.orgId!, runId: req.runId!, videoId: clip.videoId, clipId: clip.id, kind: "internal_hook", model: answer.model,
        tokensInput: answer.tokensInput, tokensOutput: answer.tokensOutput,
        request: { systemPrompt: request.systemPrompt, message: request.message, by: completion ? { completionRunId: completion.runId } : { model } },
        responseRaw: answer.responseRaw, result: choice,
      });
      hook = { type: "internal", ...choice, proposalId };
    }
    const { row, created } = await storeClip(req.orgId!, hookedClip(req, clip, hook, idempotencyKey));
    if (created) enqueueClip(row.id);
    return res.status(202).json(toClipResponse(row));
  } catch (err) {
    return sendReelsError(res, err, "POST /video-clips/:id/internal-hook", 502);
  }
});

async function libraryOrThrow(): Promise<LibraryHook[]> {
  const { hooks } = await listActiveHooks();
  if (!hooks.length) throw new ReelsError("HOOK_LIBRARY_EMPTY", "The hook library holds no active line: POST /internal/hook-library/refresh, or send an explicit `line`", 503);
  return hooks;
}

/** POST /video-clips/:id/external-hook/request: the chat-service request, minus the LLM. */
router.post("/video-clips/:id/external-hook/request", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = ExternalHookRequestBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const clip = await hookParent(req, res);
    if (!clip) return;
    const words = await clipWords(clip);
    const shown = sampleHooks(await libraryOrThrow(), clip.id);
    return res.json({ request: buildExternalHookRequest(words.map((w) => w.word).join(" "), shown, parsed.data) });
  } catch (err) {
    return sendReelsError(res, err, "POST /video-clips/:id/external-hook/request");
  }
});

/** POST /video-clips/:id/external-hook: a NEW clip = the clip with a library line over its first seconds. */
router.post("/video-clips/:id/external-hook", auth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = ExternalHookBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  const { model, completion, line, idempotencyKey, seconds: askedSeconds, ...params } = parsed.data;
  const one = exactlyOne({ model, completion, line });
  if ("status" in one) return res.status(one.status).json({ error: one.error, code: one.code });
  const seconds = askedSeconds ?? HOOK_SECONDS.default;
  try {
    assertPublicMediaBase();
    if (idempotencyKey) {
      const existing = await findClipByKey(req.orgId!, idempotencyKey);
      if (existing) return res.status(202).json(toClipResponse(existing));
    }
    const clip = await hookParent(req, res);
    if (!clip) return;

    let hook: ExternalHookData;
    if (line) {
      const text = cleanHookLine(line.text);
      if (!text) throw new ReelsError("HOOK_UNREADABLE", "line.text is empty", 400);
      const from = line.hookId ? await findHook(line.hookId) : undefined;
      if (line.hookId && !from) throw new ReelsError("HOOK_UNREADABLE", `No hook ${line.hookId} in the library`, 400);
      hook = { type: "external", hookId: from?.id ?? null, template: from?.template ?? null, text, source: from?.source ?? null, seconds, why: "", proposalId: null };
    } else {
      const words = await clipWords(clip);
      const library = await libraryOrThrow();
      const shown = sampleHooks(library, clip.id);
      const request = buildExternalHookRequest(words.map((w) => w.word).join(" "), shown, params);
      const answer = await askReelsLlm(request, completion ? { completion } : { model: model! }, callerIdentity(req));
      const byId = new Map(library.map((h) => [h.id, h]));
      const choice = readExternalHookAnswer(answer.json, (id) => byId.get(id));
      const proposalId = await insertProposal({
        orgId: req.orgId!, runId: req.runId!, videoId: clip.videoId, clipId: clip.id, kind: "external_hook", model: answer.model,
        tokensInput: answer.tokensInput, tokensOutput: answer.tokensOutput,
        request: { systemPrompt: request.systemPrompt, message: request.message, by: completion ? { completionRunId: completion.runId } : { model } },
        responseRaw: answer.responseRaw, result: { hookId: choice.hook.id, text: choice.text, why: choice.why },
      });
      hook = { type: "external", hookId: choice.hook.id, template: choice.hook.template, text: choice.text, source: choice.hook.source, seconds, why: choice.why, proposalId };
    }
    const { row, created } = await storeClip(req.orgId!, hookedClip(req, clip, hook, idempotencyKey));
    if (created) enqueueClip(row.id);
    return res.status(202).json(toClipResponse(row));
  } catch (err) {
    return sendReelsError(res, err, "POST /video-clips/:id/external-hook", 502);
  }
});

// --------------------------------------------------------------------------- hook library

router.get("/hook-library", authRead, async (req: AuthenticatedRequest, res: Response) => {
  let limit = 200;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > HOOK_LIBRARY_MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be an integer from 1 to ${HOOK_LIBRARY_MAX_LIMIT}` });
    }
  }
  const category = typeof req.query.category === "string" && req.query.category.trim() ? req.query.category.trim() : undefined;
  try {
    const { hooks, total } = await listActiveHooks({ category, limit });
    return res.json({ hooks: hooks.map((h) => ({ id: h.id, template: h.template, category: h.category, source: h.source, sourceUrl: h.sourceUrl, evidence: h.evidence })), total });
  } catch (err) {
    return sendReelsError(res, err, "GET /hook-library");
  }
});

/** POST /internal/hook-library/refresh: API key only (mounted after apiKeyAuth), no identity headers. */
router.post("/internal/hook-library/refresh", async (_req, res: Response) => {
  try {
    return res.json({ sources: await refreshHookLibrary() });
  } catch (err) {
    return sendReelsError(res, err, "POST /internal/hook-library/refresh");
  }
});

export default router;
