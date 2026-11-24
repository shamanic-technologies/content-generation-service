/**
 * Filling the hook library from its sources (REELS-1124). Each source is read and stored on its
 * own: one that fails (unreachable, parses to nothing) leaves ITS stored rows untouched and never
 * blocks the others. Rows a source no longer lists are deactivated, never deleted.
 */
import { readCappedBody } from "../capped-body.js";
import { HOOK_SOURCES, type FetchText, type HookSource } from "./hook-sources.js";
import { countActiveHooks, replaceSourceHooks } from "./store.js";

/** One source page is a few hundred KB (the rows API page: ~500 KB); 8 MiB is a wrong answer. */
const MAX_SOURCE_BODY_BYTES = 8 * 1024 * 1024;

const fetchText: FetchText = async (url) => {
  const response = await fetch(url, { headers: { Accept: "*/*", "User-Agent": "hook-library-refresh" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${new URL(url).host} answered ${response.status}`);
  }
  return (await readCappedBody(response, MAX_SOURCE_BODY_BYTES)).toString("utf8");
};

export interface SourceRefresh { source: string; ok: boolean; active?: number; deactivated?: number; error?: string }

let refreshing: Promise<SourceRefresh[]> | null = null;

/** Single flight: a refresh asked while one runs answers that one. */
export function refreshHookLibrary(sources: HookSource[] = HOOK_SOURCES, fetcher: FetchText = fetchText): Promise<SourceRefresh[]> {
  if (!refreshing) {
    refreshing = (async () => {
      const results: SourceRefresh[] = [];
      for (const source of sources) {
        try {
          const hooks = source.read ? await source.read(fetcher) : source.parse(await fetcher(source.url));
          const stored = await replaceSourceHooks(source.id, source.url, hooks);
          console.log(`[reels] hook source ${source.id}: ${stored.active} active, ${stored.deactivated} deactivated`);
          results.push({ source: source.id, ok: true, ...stored });
        } catch (err) {
          console.error(`[reels] hook source ${source.id} FAILED, its stored hooks are untouched: ${(err as Error).message}`);
          results.push({ source: source.id, ok: false, error: (err as Error).message });
        }
      }
      return results;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Boot: fill an empty library in the background. Never awaited before listen(). */
export async function refreshHookLibraryIfEmpty(): Promise<void> {
  if ((await countActiveHooks()) > 0) return;
  console.log("[reels] hook library is empty: reading its sources");
  await refreshHookLibrary();
}
