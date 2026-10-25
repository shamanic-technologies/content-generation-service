/**
 * The lead a past email was written for, read from the run tree (LEDGER-RESIDUAL-1025-SIBLINGS,
 * runs-service's ruling 2026-10-25).
 *
 * Before P1 our `single-generation` run W was opened as a SIBLING of the sends of the same email:
 * the workflow run P that called us also called instantly-service, whose send runs declare
 * `message_written` CONSUMED on the person's lead (stated from its own sequence row). So when P
 * holds exactly ONE run of ours, the email W recorded is the one those sends consumed, and when the
 * sends name exactly ONE lead, that lead is W's subject: a fact of the ledger, never a guess. Any
 * other shape (no writer, two writers, sends naming no lead or two) names nothing and is left.
 *
 * Pure: the I/O is `src/bin/declare-writers-from-sibling-sends.ts`.
 */
import { LEAD_SUBJECT_SERVICE, MESSAGE_WRITTEN, type OutcomeDeclaration } from "./run-outcomes.js";

/** Our runs under both names (`emailgeneration-service` until 2026-02): a writer is either. */
export const OWN_SERVICES: readonly string[] = ["content-generation-service", "emailgeneration-service"];
/** Mark prefix of every row this pass decided: the pass never reads such a row again. */
export const SIBLING_MARK_PREFIX = "backfill: siblings:";

export interface TreeRun {
  id: string;
  serviceName: string;
}

export interface SiblingConsumption {
  runId: string;
  direction: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export type SiblingDecision = { kind: "declare"; leadId: string } | { kind: "skip"; reason: string };

/** W's subject from P's direct children and the `message_written` consumptions of W's siblings. */
export function writerSubjectFromSiblings(writerRunId: string, children: TreeRun[], consumptions: SiblingConsumption[]): SiblingDecision {
  const writers = children.filter((c) => OWN_SERVICES.includes(c.serviceName));
  if (!writers.some((w) => w.id === writerRunId)) return { kind: "skip", reason: "writer not under its parent" };
  if (writers.length !== 1) return { kind: "skip", reason: `parent holds ${writers.length} writers` };
  const siblings = new Set(children.filter((c) => c.id !== writerRunId).map((c) => c.id));
  const leads = new Set(
    consumptions
      .filter(
        (o) =>
          siblings.has(o.runId) &&
          o.direction === "consumed" &&
          o.outcomeKey === MESSAGE_WRITTEN &&
          o.subjectService === LEAD_SUBJECT_SERVICE,
      )
      .map((o) => o.subjectId),
  );
  if (leads.size !== 1) return { kind: "skip", reason: `sibling sends consume ${leads.size} leads` };
  return { kind: "declare", leadId: [...leads][0] };
}

/**
 * What W declares: `message_written` PRODUCED on the lead, nothing consumed (the ruling states the
 * output only; an input restated here for a pipe of 2026-02..06 would be a consumption nobody produced).
 */
export function siblingDeclaration(leadId: string): OutcomeDeclaration {
  return { produced: [{ outcomeKey: MESSAGE_WRITTEN, subjectService: LEAD_SUBJECT_SERVICE, subjectId: leadId }], consumed: [] };
}
