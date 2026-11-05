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

/**
 * The identity (`blind` | `named`) of the dynasty a template is a version of, `null` when it is in none
 * (a template belongs to ONE dynasty). The identity is the truth, never the type name: several named
 * dynasties store versions under `blind-discovery-email-*` (BLIND-NAME-LEAK-1105). A merged dynasty's
 * versions moved to its target, so the row read is always the live one.
 */
export async function dynastyIdentityOf(type: string): Promise<"blind" | "named" | null> {
  const rows = (await db.execute(sql`
    SELECT d.identity FROM template_dynasty_versions v JOIN template_dynasties d ON d.slug = v.dynasty_slug
    WHERE v.prompt_type = ${type} LIMIT 1`)) as unknown as Array<{ identity: string }>;
  const identity = rows[0]?.identity;
  if (identity === undefined) return null;
  if (identity !== "blind" && identity !== "named") throw new Error(`Dynasty of ${type} has an unknown identity "${identity}"`);
  return identity;
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
