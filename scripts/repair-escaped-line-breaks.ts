/**
 * One-shot repair of stored generations whose sequence steps carry over-escaped
 * line breaks (the two characters backslash + `n` instead of a real newline).
 *
 * #153 fixed generation time; rows written before it still hold the model's raw
 * output, and the dashboard lead-detail timeline renders that stored copy — so a
 * customer sees visible backslash-n in follow-up content that the prospect
 * receives as real paragraphs. The data is wrong at rest, so it is fixed at rest:
 * no read-side transform, no boot-path wiring, run manually.
 *
 * Usage (dry-run prints what it WOULD touch and writes nothing):
 *   CONTENT_GENERATION_SERVICE_DATABASE_URL=... pnpm tsx scripts/repair-escaped-line-breaks.ts
 *   CONTENT_GENERATION_SERVICE_DATABASE_URL=... pnpm tsx scripts/repair-escaped-line-breaks.ts --apply
 *
 * Idempotent: the repair decision is "does this step still carry an escaped line
 * break", so a second run rewrites nothing. Because an already-applied run
 * therefore prints zeros — indistinguishable from a no-op — the script ends by
 * READING BACK the remaining-dirty counts from the database (bronze table and the
 * silver example view) rather than reporting its own tally.
 *
 * `email_examples_silver` is a VIEW over `email_generations` (drizzle/0025), so
 * repairing the table repairs the examples mirror by construction; the read-back
 * asserts that rather than assuming it.
 */
import { sql } from "../src/db/index.js";
import { repairSequence } from "../src/lib/escaped-line-break-repair.js";

const apply = process.argv.includes("--apply");
const BACKSLASH = String.fromCharCode(92);

interface Row {
  id: string;
  /** Driver-dependent: a Date on a typed connection, an ISO string otherwise. */
  created_at: Date | string;
  sequence: unknown;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

async function countDirty(relation: "email_generations" | "email_examples_silver"): Promise<number> {
  // Mirrors repairSequence's decision in SQL: a step whose bodyText/bodyHtml
  // contains a backslash immediately followed by n or r.
  const [row] = await sql<{ dirty: string }[]>`
    SELECT count(*)::text AS dirty
    FROM ${sql(relation)} g
    WHERE jsonb_typeof(g.sequence) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(g.sequence) e
        WHERE strpos(COALESCE(e->>'bodyText', ''), ${BACKSLASH + "n"}) > 0
           OR strpos(COALESCE(e->>'bodyText', ''), ${BACKSLASH + "r"}) > 0
           OR strpos(COALESCE(e->>'bodyHtml', ''), ${BACKSLASH + "n"}) > 0
           OR strpos(COALESCE(e->>'bodyHtml', ''), ${BACKSLASH + "r"}) > 0
      )
  `;
  return Number(row.dirty);
}

async function main(): Promise<void> {
  console.log(`[repair-escaped-line-breaks] mode=${apply ? "APPLY" : "DRY-RUN"}`);

  // Coarse pre-filter: an over-escaped break serialises as a doubled backslash in
  // the jsonb text. It can also match a legitimate backslash in the content, so
  // repairSequence makes the real decision on every candidate.
  const candidates = await sql<Row[]>`
    SELECT id, created_at, sequence
    FROM email_generations
    WHERE jsonb_typeof(sequence) = 'array'
      AND strpos(sequence::text, ${BACKSLASH + BACKSLASH}) > 0
    ORDER BY created_at
  `;
  console.log(`[repair-escaped-line-breaks] candidates scanned: ${candidates.length}`);

  let dirtyRows = 0;
  let dirtySteps = 0;
  let written = 0;
  let firstSeen: Date | string | null = null;
  let lastSeen: Date | string | null = null;

  for (const row of candidates) {
    const repair = repairSequence(row.sequence);
    if (!repair) continue;

    dirtyRows++;
    dirtySteps += repair.repairedSteps;
    firstSeen ??= row.created_at;
    lastSeen = row.created_at;

    if (apply) {
      await sql`
        UPDATE email_generations
        SET sequence = ${sql.json(repair.sequence as never)}
        WHERE id = ${row.id}
      `;
      written++;
    }
  }

  console.log(
    `[repair-escaped-line-breaks] rows ${apply ? "repaired" : "that WOULD be repaired"}: ${dirtyRows} (${dirtySteps} steps)` +
      (firstSeen ? ` window ${iso(firstSeen)} → ${iso(lastSeen!)}` : "")
  );
  if (apply) console.log(`[repair-escaped-line-breaks] rows written: ${written}`);

  // Read back from the database — an already-applied idempotent run reports zeros
  // above, which on its own is indistinguishable from having done nothing.
  const [remainingBronze, remainingSilver] = await Promise.all([
    countDirty("email_generations"),
    countDirty("email_examples_silver"),
  ]);
  console.log(
    `[repair-escaped-line-breaks] read-back — still dirty: email_generations=${remainingBronze}, email_examples_silver=${remainingSilver}`
  );

  if (apply && remainingBronze + remainingSilver > 0) {
    throw new Error(
      `repair incomplete: ${remainingBronze} generation(s) and ${remainingSilver} example row(s) still carry an over-escaped line break`
    );
  }
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error("[repair-escaped-line-breaks] FAILED", err);
    await sql.end();
    process.exit(1);
  });
