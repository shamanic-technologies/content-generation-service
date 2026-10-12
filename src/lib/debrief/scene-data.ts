/**
 * Builds the scene's DATA block (assets/industry-debrief/scene.html) from a
 * render request. Pure: everything the skill fixes (industry name, intro wording,
 * sign-off) lives here, everything that changes day to day comes from the request.
 */
import type { DebriefVideoRequest } from "../../schemas.js";

/** Named on screen (owner, 2026-09-28): never "cold outbound". */
export const INDUSTRY = "Revenue Automation & Done-For-You";

const COUNT_WORDS: Record<number, string> = { 2: "Two", 3: "Three", 4: "Four" };

export interface SceneStory {
  key: string;
  kicker: string;
  relation: "official" | "own" | "third";
  name?: string;
  role: string;
  about: string;
  head: string;
  why: string;
  note: string;
  take: string;
}

export interface SceneData {
  date: string;
  industry: string;
  intro: { head: string; count: number; sub: string };
  stories: SceneStory[];
  outro: { head: string; sub: string };
}

/** The scene writes these through innerHTML: escape what HTML would read as markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "2026-10-12" -> "Sunday, Oct 12" (the masthead date). */
export function formatBulletinDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${weekday}, ${month} ${d.getUTCDate()}`;
}

/** Story i's capture key: post-<key>.png + its rects in posts.js. */
export const storyKey = (i: number): string => `s${i + 1}`;

export function buildSceneData(req: DebriefVideoRequest): SceneData {
  const n = req.stories.length;
  const count = req.scan.postsRead;
  return {
    date: formatBulletinDate(req.date),
    industry: INDUSTRY,
    // "spotted", never "worth knowing": the picks are not all there is (owner).
    intro: {
      head: `${COUNT_WORDS[n]} things we spotted today`,
      count,
      sub: `<b id="icount">${count}</b> posts read from the last ${req.scan.windowHours} hours`,
    },
    stories: req.stories.map((s, i) => ({
      key: storyKey(i),
      kicker: escapeHtml(s.kicker),
      relation: s.poster.relation,
      ...(s.poster.name ? { name: escapeHtml(s.poster.name) } : {}),
      role: escapeHtml(s.poster.role),
      about: escapeHtml(s.poster.about),
      head: escapeHtml(s.headline),
      why: escapeHtml(s.why),
      note: escapeHtml(s.note),
      take: escapeHtml(s.take),
    })),
    outro: {
      head: `That was what we spotted today in ${INDUSTRY}. What did we miss?`,
      sub: "Links to every post are in the caption.",
    },
  };
}
