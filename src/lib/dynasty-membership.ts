import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notDynastyHead, sourceInDynasty } from "./template-dynasties.js";

/**
 * Which dynasties a template is a version of (TPL-DYNASTY-ROWS-1021-CG), and the two write guards
 * built on it. Raw SQL, no schema import: prompt-versioning.ts calls it and many unit suites mock
 * the schema module. Rules: template-dynasties.ts.
 */
export async function dynastiesHolding(type: string): Promise<Array<{ slug: string; head: string | null }>> {
  const rows = (await db.execute(sql`
    SELECT v.dynasty_slug AS slug,
      (SELECT h.prompt_type FROM template_dynasty_versions h WHERE h.dynasty_slug = v.dynasty_slug ORDER BY h.position DESC LIMIT 1) AS head
    FROM template_dynasty_versions v WHERE v.prompt_type = ${type} ORDER BY v.dynasty_slug`)) as unknown as Array<{ slug: string; head: string | null }>;
  return rows.map((r) => ({ slug: r.slug, head: r.head }));
}

/** Refuses a staff re-activation that would leave a non-head version Active (NOT_DYNASTY_HEAD). */
export async function assertMayActivate(type: string): Promise<void> {
  const held = await dynastiesHolding(type);
  if (held.length > 0 && !held.some((d) => d.head === type)) throw notDynastyHead(type, held);
}

/** Refuses a loose fork of a dynasty version (SOURCE_IN_DYNASTY): its new version belongs in the dynasty. */
export async function assertNotDynastySource(type: string): Promise<void> {
  const held = await dynastiesHolding(type);
  if (held.length > 0) throw sourceInDynasty(type, held.map((d) => d.slug));
}
