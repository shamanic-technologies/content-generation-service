import { describe, it, expect } from "vitest";
import { siblingDeclaration, writerSubjectFromSiblings, type SiblingConsumption } from "../../src/lib/sibling-writer-subject.js";

// LEDGER-RESIDUAL-1025-SIBLINGS: shape of a pre-P1 workflow run P (measured 2026-10-25): our writer W,
// the lead serve, the completion and instantly-service's send runs, all direct children of P.
const W = "w-1";
const children = [
  { id: W, serviceName: "content-generation-service" },
  { id: "send-1", serviceName: "instantly-service" },
  { id: "send-2", serviceName: "instantly-service" },
  { id: "chat-1", serviceName: "chat-service" },
];
const consumed = (runId: string, subjectId: string, extra: Partial<SiblingConsumption> = {}): SiblingConsumption => ({
  runId,
  direction: "consumed",
  outcomeKey: "message_written",
  subjectService: "lead-service",
  subjectId,
  ...extra,
});

describe("writerSubjectFromSiblings", () => {
  it("the one lead the sibling sends consumed is the writer's subject", () => {
    expect(writerSubjectFromSiblings(W, children, [consumed("send-1", "lead-a"), consumed("send-2", "lead-a")])).toEqual({ kind: "declare", leadId: "lead-a" });
  });

  it("sends naming two leads, or none, name nothing", () => {
    expect(writerSubjectFromSiblings(W, children, [consumed("send-1", "lead-a"), consumed("send-2", "lead-b")])).toMatchObject({ kind: "skip" });
    expect(writerSubjectFromSiblings(W, children, [])).toMatchObject({ kind: "skip", reason: "sibling sends consume 0 leads" });
  });

  it("two writers under the parent: which email each wrote is not on the ledger, skip", () => {
    const two = [...children, { id: "w-2", serviceName: "content-generation-service" }];
    expect(writerSubjectFromSiblings(W, two, [consumed("send-1", "lead-a")])).toEqual({ kind: "skip", reason: "parent holds 2 writers" });
  });

  it("only siblings' message_written consumptions on lead-service count", () => {
    const noise = [
      consumed("send-1", "lead-a"),
      consumed("elsewhere", "lead-b"),
      consumed("send-2", "lead-c", { outcomeKey: "lead_found" }),
      consumed("send-2", "x.com", { subjectService: "brand-service" }),
      consumed("send-2", "lead-d", { direction: "produced" }),
    ];
    expect(writerSubjectFromSiblings(W, children, noise)).toEqual({ kind: "declare", leadId: "lead-a" });
  });

  it("a run of ours under its old name (emailgeneration-service) is a writer too", () => {
    const old = [...children, { id: "w-old", serviceName: "emailgeneration-service" }];
    expect(writerSubjectFromSiblings(W, old, [consumed("send-1", "lead-a")])).toEqual({ kind: "skip", reason: "parent holds 2 writers" });
  });

  it("a writer absent from its parent's children is skipped", () => {
    expect(writerSubjectFromSiblings("w-9", children, [consumed("send-1", "lead-a")])).toMatchObject({ kind: "skip" });
  });
});

describe("siblingDeclaration", () => {
  it("produces message_written on the lead and restates no input", () => {
    expect(siblingDeclaration("lead-a")).toEqual({
      produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-a" }],
      consumed: [],
    });
  });
});
