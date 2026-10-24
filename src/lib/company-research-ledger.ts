/**
 * Which companies lead-service DECLARED as researched (COMPANY-RESEARCHED-PROVENANCE-1024).
 *
 * A message consumes `company_researched` on a company only when some run actually PRODUCED that
 * occurrence: what qualifies as research is lead-service's to state, and it states it by declaring
 * `company_researched` (subject `lead-service`/<domain>) on its research run. A company researched
 * inside a serve run before 2026-10-23 rides that serve's `lead_found` by design and has no separate
 * occurrence: consuming one would be unknown provenance on the ledger. So the declaration reads the
 * ledger itself (runs-service `GET /internal/outcome-occurrences`, produced side) and keeps only the
 * companies found there. Never an invented production, never a guess.
 *
 * A read failure throws: the caller retries (a declaration is never sent on a guess).
 */
import { COMPANY_RESEARCHED, LEAD_SUBJECT_SERVICE } from "./run-outcomes.js";

const PAGE_LIMIT = 1000;
const MAX_SUBJECTS_PER_READ = 100;

type ProducedOccurrence = { subjectId: string; declaredAt: string };

/** Pages runs-service's produced `company_researched` of these companies; `stop` ends a chunk early. */
async function readProduced(
  domains: string[],
  onPage: (occurrences: ProducedOccurrence[]) => void,
  opts: { declaredBefore?: string; stop?: (chunk: string[]) => boolean } = {},
): Promise<void> {
  const wanted = [...new Set(domains)];
  const base = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
  for (let i = 0; i < wanted.length; i += MAX_SUBJECTS_PER_READ) {
    const chunk = wanted.slice(i, i + MAX_SUBJECTS_PER_READ);
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({
        subjectService: LEAD_SUBJECT_SERVICE,
        subjectIds: chunk.join(","),
        outcomeKey: COMPANY_RESEARCHED,
        direction: "produced",
        limit: String(PAGE_LIMIT),
      });
      if (opts.declaredBefore) q.set("declaredBefore", opts.declaredBefore);
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(`${base}/internal/outcome-occurrences?${q}`, {
        headers: { "X-API-Key": process.env.RUNS_SERVICE_API_KEY || "" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`runs-service GET /internal/outcome-occurrences failed: ${res.status} - ${text.slice(0, 300)}`);
      }
      const body = (await res.json()) as { occurrences: ProducedOccurrence[]; nextCursor: string | null };
      onPage(body.occurrences);
      cursor = body.nextCursor;
    } while (cursor && !opts.stop?.(chunk));
  }
}

/**
 * The subset of `domains` with at least one produced `company_researched` declared before
 * `declaredBefore` (ISO; absent = any time). runs-service resolves a consumption to a production
 * declared before the end of the consumption's UTC day.
 */
export async function producedResearchDomains(domains: string[], declaredBefore?: string): Promise<Set<string>> {
  const found = new Set<string>();
  await readProduced(domains, (page) => page.forEach((o) => found.add(o.subjectId)), {
    declaredBefore,
    stop: (chunk) => chunk.every((d) => found.has(d)),
  });
  return found;
}

/** Per company, the earliest declaration time (ISO) of a produced `company_researched`; absent = never produced. */
export async function firstResearchProducedAt(domains: string[]): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  await readProduced(domains, (page) => {
    for (const o of page) {
      const prev = first.get(o.subjectId);
      if (!prev || new Date(o.declaredAt).getTime() < new Date(prev).getTime()) first.set(o.subjectId, o.declaredAt);
    }
  });
  return first;
}

/** End of the UTC day of `instant` (exclusive bound), as ISO. */
export function endOfUtcDay(instant: Date): string {
  const d = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1));
  return d.toISOString();
}
