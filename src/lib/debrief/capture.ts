/**
 * Captures each story's post from its PUBLIC embed (no login): a 420 CSS px wide,
 * DPR 2 full-page screenshot plus the rects of the sentences to spotlight, the
 * poster's name/role/age/avatar and the page height. Port of the
 * industry-debrief-video skill's cap.mjs; the in-page half is
 * assets/industry-debrief/capture-page.js.
 *
 * A post that does not load is EMBED_UNREACHABLE; a sentence that is not verbatim
 * is SPOTLIGHT_NOT_FOUND. Both name the story, so the caller fixes the input.
 */
import type { Browser } from "playwright";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DebriefError } from "./errors.js";
import type { DebriefStory } from "../../schemas.js";

export const CAPTURE_WIDTH = 420;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const SETTLE_MS = 2500;

export interface CapturedPost {
  marks: Record<string, number[][]>;
  who: { name: string; role: string; age: string; src?: string; avatar: number[] | null };
  from?: number;
  H: number;
}

export function embedUrl(post: DebriefStory["post"]): string {
  if (post.platform === "linkedin") return `https://www.linkedin.com/embed/feed/update/urn:li:activity:${post.activityId}`;
  return `https://platform.twitter.com/embed/Tweet.html?id=${post.tweetId}&theme=light&dnt=true`;
}

interface LocateResult {
  marks: Record<string, number[][] | null>;
  who: CapturedPost["who"] | null;
  from?: number | null;
  H: number;
  textLength: number;
}

/** Turns the in-page result into a CapturedPost or the named error. Pure: unit-tested. */
export function checkCapture(storyIndex: number, url: string, r: LocateResult, cropFrom?: string): CapturedPost {
  const label = `Story ${storyIndex + 1} (${url})`;
  if (!r.who || !r.who.name || r.textLength < 20) {
    throw new DebriefError("EMBED_UNREACHABLE", `${label}: the public embed rendered no post (deleted, private, or a wrong id)`);
  }
  const missing = Object.entries(r.marks).filter(([, v]) => !v || v.length === 0).map(([k]) => k);
  if (missing.length) {
    throw new DebriefError(
      "SPOTLIGHT_NOT_FOUND",
      `${label}: not verbatim in the post: ${missing.map((m) => JSON.stringify(m)).join(", ")}`,
    );
  }
  if (cropFrom !== undefined && (r.from === null || r.from === undefined)) {
    throw new DebriefError("CROP_PHRASE_NOT_FOUND", `${label}: cropFrom ${JSON.stringify(cropFrom)} is not verbatim in the post`);
  }
  return {
    marks: r.marks as Record<string, number[][]>,
    who: r.who,
    ...(cropFrom !== undefined ? { from: r.from as number } : {}),
    H: r.H,
  };
}

export async function capturePosts(
  browser: Browser,
  stories: Array<{ key: string; story: DebriefStory }>,
  dir: string,
  scriptPath: string,
): Promise<Record<string, CapturedPost>> {
  const page = await browser.newPage({
    viewport: { width: CAPTURE_WIDTH, height: 300 },
    deviceScaleFactor: 2,
    userAgent: USER_AGENT,
  });
  try {
    const locateSource = await readFile(scriptPath, "utf8");
    const out: Record<string, CapturedPost> = {};
    for (const [i, { key, story }] of stories.entries()) {
      const url = embedUrl(story.post);
      let status: number | undefined;
      try {
        const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
        status = res?.status();
      } catch (err) {
        throw new DebriefError("EMBED_UNREACHABLE", `Story ${i + 1} (${url}): ${(err as Error).message.split("\n")[0]}`);
      }
      if (status !== undefined && status >= 400) {
        throw new DebriefError("EMBED_UNREACHABLE", `Story ${i + 1} (${url}): HTTP ${status}`);
      }
      if (story.post.platform === "x") await page.waitForTimeout(SETTLE_MS);
      await page.waitForTimeout(SETTLE_MS);
      // Evaluated over CDP, not as a <script> tag: LinkedIn's CSP blocks injected inline scripts.
      const r = (await page.evaluate(
        `${locateSource}\n;window.__debriefLocate(${JSON.stringify(story.spotlight)}, ${JSON.stringify(story.cropFrom ?? null)})`,
      )) as LocateResult;
      const captured = checkCapture(i, url, r, story.cropFrom);
      await page.screenshot({ path: join(dir, `post-${key}.png`), fullPage: true });
      out[key] = captured;
    }
    return out;
  } finally {
    await page.close();
  }
}
