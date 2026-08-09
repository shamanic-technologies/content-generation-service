import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CI builds the integration database from nothing (a postgres:16 container per run), so the
 * journal is replayed against an EMPTY database on every PR. Before that, CI forked a Neon
 * branch from production — every relation already existed, so a statement that silently
 * depends on one was never actually exercised.
 *
 * That is how `0000_marvelous_speed.sql` shipped with a bare
 * `ALTER TABLE "email_generations" DROP COLUMN IF EXISTS "cost_usd"` placed BEFORE the
 * `CREATE TABLE` for that same table: against production it was a no-op, against an empty
 * database it is `relation "email_generations" does not exist` and the whole replay aborts.
 *
 * This guard is the DB-free version of that replay: it reads the journal in order and checks
 * that every statement naming a relation either guards itself with `IF EXISTS` or names a
 * relation an earlier (or the same) migration has already created. It cannot replace running
 * the migrations, but it fails in a unit test — with the offending file and statement named —
 * instead of somewhere inside a Postgres error at integration time.
 */

const DRIZZLE_DIR = join(__dirname, "../../drizzle");

interface JournalEntry {
  idx: number;
  tag: string;
}

function journalEntries(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8"));
  return journal.entries as JournalEntry[];
}

function statements(tag: string): string[] {
  return readFileSync(join(DRIZZLE_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        // strip line comments so a relation named only in prose is never matched
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

const name = String.raw`"?([a-z_][a-z0-9_]*)"?`;

/** Statements that CREATE a relation, making it available to everything after them. */
const CREATES = [
  new RegExp(String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?${name}`, "i"),
  new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+${name}`, "i"),
];

/**
 * Statements that REQUIRE a relation to already exist. Each carries the guard clause that
 * makes it safe against an absent relation, when Postgres offers one.
 */
const REQUIRES: Array<{ label: string; re: RegExp; guard?: RegExp }> = [
  {
    label: "ALTER TABLE",
    re: new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?${name}`, "i"),
    guard: /\balter\s+table\s+if\s+exists\b/i,
  },
  {
    label: "CREATE INDEX ... ON",
    re: new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?"?[a-z0-9_]+"?\s+on\s+(?:"public"\.)?${name}`, "i"),
  },
  // Anchored to the start of a line: `ON UPDATE no action` / `ON DELETE cascade` are foreign-key
  // clauses, not statements, and naming a relation is not what they do.
  { label: "INSERT INTO", re: new RegExp(String.raw`^\s*insert\s+into\s+(?:"public"\.)?${name}`, "im") },
  { label: "UPDATE", re: new RegExp(String.raw`^\s*update\s+(?:"public"\.)?${name}`, "im") },
  { label: "DELETE FROM", re: new RegExp(String.raw`^\s*delete\s+from\s+(?:"public"\.)?${name}`, "im") },
];

describe("drizzle journal replays against an empty database", () => {
  it("never touches a relation before some migration creates it", () => {
    const created = new Set<string>();
    const violations: string[] = [];

    for (const entry of journalEntries()) {
      for (const stmt of statements(entry.tag)) {
        for (const { label, re, guard } of REQUIRES) {
          const match = stmt.match(re);
          if (!match) continue;
          if (guard?.test(stmt)) continue;
          const relation = match[1].toLowerCase();
          if (created.has(relation)) continue;
          violations.push(
            `${entry.tag}.sql: ${label} "${relation}" before any migration creates it — ` +
              `guard it (ALTER TABLE IF EXISTS) or move it after the CREATE`,
          );
        }

        for (const re of CREATES) {
          const match = stmt.match(re);
          if (match) created.add(match[1].toLowerCase());
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("has a .sql file on disk for every journal entry", () => {
    for (const entry of journalEntries()) {
      expect(() => readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`))).not.toThrow();
    }
  });
});
