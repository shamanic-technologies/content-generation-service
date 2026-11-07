/**
 * A cold-email generation is ONE email: the first one (FOLLOWUP-JIT-1107, owner 2026-11-07).
 *
 * Follow-ups are no longer written with the first email: each one is written on the day it
 * is due by the follow-up path, with the lead's latest context, and paid then. Writing them
 * up front made the sender hold the sending cost of every follow-up for 3 to 10 days.
 *
 * The system prompt asks for a single email (GLOBAL_SYSTEM_PROMPT); this is the
 * deterministic half, like the dash strip: stored template versions written for a
 * multi-step sequence may still answer with several steps, and only the first is kept.
 * Never a check, retry or refusal on the writer's output. Applied wherever this service
 * turns a writer's answer into a served sequence (a fresh completion, a script writer's
 * answer, and a stored generation it answers with again), so the sender only ever
 * receives one step. History reads (`GET /generations`, by-lead) serve rows as stored.
 *
 * Standalone leaf (never `vi.mock`'d).
 */
export function firstEmailOnly<T>(steps: T[]): T[] {
  return steps.slice(0, 1);
}
