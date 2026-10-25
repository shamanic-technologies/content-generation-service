/**
 * A writer model's status on a pipe belongs to its LLM DYNASTY, never to one name
 * (LLM-DYNASTY-DEPRECATE-1025, owner: two models sold side by side at two prices are two
 * dynasties; the versions and aliases of one dynasty share their fate).
 *
 * chat-service accepts several names per dynasty (`kimi-k3`, `kimi-pro`; `claude-opus`,
 * `claude-opus-5-5`, `opus`). A deprecation stored for ONE name left its siblings active,
 * and features-service's writer pick calls a dynasty under any active name: Kimi K3 kept
 * writing on a pipe the owner had stopped it on (18 emails, 2026-10-24).
 *
 * - Write: a change on one name is written for EVERY name of its dynasty on that pipe, same
 *   status, reason, author and instant (`setModelStatus`).
 * - Read: the status of a dynasty on a pipe is its most recent change on that pipe, whichever
 *   name it was stated on; every name serves it (`effectiveDynastyPipeRows`). A name chat-service
 *   adds to a dynasty later serves the dynasty's status at once.
 * - Boot: rows still split (a name added since, rows written before this) are aligned on that
 *   most recent change (`dynastyStatusAlignment`), so the table never holds a split dynasty.
 *
 * A name chat-service serves without a dynasty is its own group. Standalone leaf (pure).
 */

export interface DynastyMember {
  model: string;
  dynasty: string | null;
}

export interface PipeStatusRow {
  model: string;
  featureSlug: string;
  legKey: string;
  status: "active" | "deprecated";
  statusChangedAt: Date;
  statusReason: string | null;
  statusChangedBy: string | null;
}

/** The group a name's status belongs to: its dynasty, else the name alone. */
export const dynastyKey = (m: DynastyMember): string => m.dynasty ?? `model:${m.model}`;

/** Every name of `entry`'s dynasty in the catalogue (the entry itself included). */
export function dynastyMembers(catalogue: DynastyMember[], entry: DynastyMember): string[] {
  const key = dynastyKey(entry);
  const names = catalogue.filter((m) => dynastyKey(m) === key).map((m) => m.model);
  return names.includes(entry.model) ? names : [...names, entry.model];
}

const pipeOf = (r: { featureSlug: string; legKey: string }) => `${r.featureSlug}\u0000${r.legKey}`;

/**
 * Per dynasty key: its status on each pipe = the most recent row on that pipe among its
 * names, oldest change first. Rows of a name chat-service no longer accepts are ignored.
 */
export function effectiveDynastyPipeRows(catalogue: DynastyMember[], rows: PipeStatusRow[]): Map<string, PipeStatusRow[]> {
  const keyOf = new Map(catalogue.map((m) => [m.model, dynastyKey(m)]));
  const latest = new Map<string, Map<string, PipeStatusRow>>();
  for (const r of rows) {
    const key = keyOf.get(r.model);
    if (!key) continue;
    const pipes = latest.get(key) ?? new Map<string, PipeStatusRow>();
    const held = pipes.get(pipeOf(r));
    if (!held || r.statusChangedAt.getTime() > held.statusChangedAt.getTime()) pipes.set(pipeOf(r), r);
    latest.set(key, pipes);
  }
  const out = new Map<string, PipeStatusRow[]>();
  for (const [key, pipes] of latest) {
    out.set(key, [...pipes.values()].sort((a, b) => a.statusChangedAt.getTime() - b.statusChangedAt.getTime()));
  }
  return out;
}

/**
 * The rows to write so every name of every dynasty holds its dynasty's status on each pipe
 * (a missing row or a row differing from the dynasty's most recent change). Empty = aligned.
 */
export function dynastyStatusAlignment(catalogue: DynastyMember[], rows: PipeStatusRow[]): PipeStatusRow[] {
  const effective = effectiveDynastyPipeRows(catalogue, rows);
  const stored = new Map(rows.map((r) => [`${r.model}\u0000${pipeOf(r)}`, r]));
  const writes: PipeStatusRow[] = [];
  for (const m of catalogue) {
    for (const target of effective.get(dynastyKey(m)) ?? []) {
      const own = stored.get(`${m.model}\u0000${pipeOf(target)}`);
      const same =
        own &&
        own.status === target.status &&
        own.statusReason === target.statusReason &&
        own.statusChangedBy === target.statusChangedBy &&
        own.statusChangedAt.getTime() === target.statusChangedAt.getTime();
      if (!same) writes.push({ ...target, model: m.model });
    }
  }
  return writes;
}
