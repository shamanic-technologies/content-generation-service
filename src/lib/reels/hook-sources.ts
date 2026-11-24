/**
 * Where the hook library comes from (REELS-1124). Each adapter reads ONE public source and
 * parses it into hook lines; hook-library.ts stores them. Pure but for the injected fetch.
 * What we keep of each source and its licence: assets/reels/HOOK-SOURCES.md.
 *
 * 1. `viral-hooks-skill` (MIT, github.com/rediumvex/viral-hooks-skill): 100 fill-in formulas
 *    with [blanks], in markdown tables under category headings. No performance data.
 * 2. `tiktok-hooks-finetune` (MIT, huggingface.co/datasets/benxh/tiktok-hooks-finetune): real
 *    TikTok on-screen hooks with their views. Kept: English hooks of 3..14 words that beat their
 *    own account's usual views 10x or more, the 300 most viewed. NEVER the video URL nor the
 *    creator handle: neither leaves the parse.
 */
import { createHash } from "node:crypto";

export interface ParsedHook {
  template: string;
  category?: string | null;
  evidence?: Record<string, unknown> | null;
}

export type FetchText = (url: string) => Promise<string>;

export interface HookSource {
  id: string;
  /** The page a reader can open; also the first URL fetched. */
  url: string;
  /** One fetched body → the hooks it holds. */
  parse(body: string): ParsedHook[];
  /** Sources spread over several pages read them here; default = parse(fetch(url)). */
  read?(fetchText: FetchText, options?: { sleep?: (ms: number) => Promise<void>; log?: (message: string) => void }): Promise<ParsedHook[]>;
}

/** Stable across refreshes: the same line of the same source keeps its id (old clips name it). */
export function hookId(source: string, template: string): string {
  return `${source}:${createHash("sha1").update(template).digest("hex").slice(0, 12)}`;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
/** Wrapping straight or curly quotes off, when they wrap the whole line. */
export function unquote(s: string): string {
  const t = collapse(s);
  const m = /^["“”']([\s\S]*)["“”']$/.exec(t);
  return m && !/["“”]/.test(m[1]) ? collapse(m[1]) : t;
}

// ---------------------------------------------------------------------------
// 1. viral-hooks-skill: markdown tables `| ID | Formula | Example | Platform |` under `## Category NN — Name`
// ---------------------------------------------------------------------------

export function parseViralHooksMarkdown(body: string): ParsedHook[] {
  const hooks: ParsedHook[] = [];
  let category: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      // "Category 01 — Curiosity Gap" → "Curiosity Gap"; a heading that is no category ends the tables.
      const named = /^Category\s+\d+\s*[—–-]\s*(.+)$/i.exec(heading[1].trim());
      category = named ? collapse(named[1]) : null;
      continue;
    }
    if (!category || !line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue; // header + separator rows
    const template = unquote(cells[1]);
    if (!template) continue;
    hooks.push({ template, category, evidence: { example: unquote(cells[2]), platform: collapse(cells[3]) } });
  }
  return hooks;
}

export const viralHooksSkill: HookSource = {
  id: "viral-hooks-skill",
  url: "https://raw.githubusercontent.com/rediumvex/viral-hooks-skill/main/hooks-database.md",
  parse: parseViralHooksMarkdown,
};

// ---------------------------------------------------------------------------
// 2. tiktok-hooks-finetune: Hugging Face rows API, 100 rows a page
// ---------------------------------------------------------------------------

export const TIKTOK_PAGES = 40;
export const TIKTOK_PAGE_LENGTH = 100;
export const TIKTOK_PAGE_PAUSE_MS = 300;
export const TIKTOK_PAGE_ATTEMPTS = 3;
export const TIKTOK_MIN_OUTLIER = 10;
export const TIKTOK_MIN_WORDS = 3;
export const TIKTOK_MAX_WORDS = 14;
export const TIKTOK_KEEP = 300;

const TIKTOK_ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=benxh/tiktok-hooks-finetune&config=default&split=train";
export const tiktokPageUrl = (page: number) => `${TIKTOK_ROWS_URL}&offset=${page * TIKTOK_PAGE_LENGTH}&length=${TIKTOK_PAGE_LENGTH}`;

/** The rows API serves every figure as a STRING ("3608", "1.682835821"): a strictly numeric string is read, anything else is null. */
const count = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
  return null;
};

/** One rows-API page → the hooks passing the keep rule. Reads text_hook, text_hook_lang, views, likes, shares, outlier_multiplier, main_category only. */
export function parseTikTokPage(body: string): ParsedHook[] {
  const page = JSON.parse(body) as { rows?: Array<{ row?: Record<string, unknown> }> };
  if (!Array.isArray(page.rows)) throw new Error("rows API answered no `rows` array");
  const hooks: ParsedHook[] = [];
  for (const { row } of page.rows) {
    if (!row || row.text_hook_lang !== "en" || typeof row.text_hook !== "string") continue;
    const outlier = count(row.outlier_multiplier);
    if (outlier === null || outlier < TIKTOK_MIN_OUTLIER) continue;
    const template = unquote(row.text_hook);
    const words = template.split(" ").filter(Boolean).length;
    if (words < TIKTOK_MIN_WORDS || words > TIKTOK_MAX_WORDS) continue;
    hooks.push({
      template,
      category: typeof row.main_category === "string" && row.main_category.trim() ? row.main_category.trim() : null,
      evidence: { views: count(row.views), likes: count(row.likes), shares: count(row.shares), outlierMultiplier: Math.round(outlier * 100) / 100 },
    });
  }
  return hooks;
}

/** Deduped on the normalized text (the most viewed copy wins), then the TIKTOK_KEEP most viewed. */
export function selectTikTokHooks(hooks: ParsedHook[]): ParsedHook[] {
  const views = (h: ParsedHook) => (typeof h.evidence?.views === "number" ? (h.evidence.views as number) : 0);
  const best = new Map<string, ParsedHook>();
  for (const h of hooks) {
    const key = h.template.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key) continue;
    const seen = best.get(key);
    if (!seen || views(h) > views(seen)) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => views(b) - views(a) || (a.template < b.template ? -1 : 1)).slice(0, TIKTOK_KEEP);
}

export const tiktokHooksFinetune: HookSource = {
  id: "tiktok-hooks-finetune",
  url: "https://huggingface.co/datasets/benxh/tiktok-hooks-finetune",
  parse: parseTikTokPage,
  /**
   * A BOUNDED read: TIKTOK_PAGES pages, one after the other, TIKTOK_PAGE_PAUSE_MS apart. A page
   * failing TIKTOK_PAGE_ATTEMPTS times stops the read and keeps what was read (logged loud);
   * nothing read at all = the source failed (its stored rows stay untouched).
   */
  async read(fetchText, options = {}) {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const log = options.log ?? ((m: string) => console.error(m));
    const all: ParsedHook[] = [];
    let pagesRead = 0;
    pages: for (let page = 0; page < TIKTOK_PAGES; page++) {
      if (page > 0) await sleep(TIKTOK_PAGE_PAUSE_MS);
      for (let attempt = 1; ; attempt++) {
        try {
          all.push(...parseTikTokPage(await fetchText(tiktokPageUrl(page))));
          pagesRead++;
          break;
        } catch (err) {
          if (attempt >= TIKTOK_PAGE_ATTEMPTS) {
            log(`[reels] hook source tiktok-hooks-finetune: page ${page} FAILED ${attempt} times (${(err as Error).message}); read stopped, keeping the ${pagesRead} page(s) read`);
            break pages;
          }
          await sleep(TIKTOK_PAGE_PAUSE_MS * attempt * 3);
        }
      }
    }
    if (pagesRead === 0) throw new Error("no page of the rows API could be read");
    return selectTikTokHooks(all);
  },
};

export const HOOK_SOURCES: HookSource[] = [viralHooksSkill, tiktokHooksFinetune];
