import { describe, it, expect } from "vitest";
import { planRunCorrection } from "../../src/lib/company-research-correction.js";
import { endOfUtcDay } from "../../src/lib/company-research-ledger.js";

// COMPANY-RESEARCHED-PROVENANCE-1024: per run, take back the companies nobody produced, keep the rest.
const at = "2026-09-01T10:00:00.000Z";
const lead = { outcomeKey: "lead_found", subjectId: "lead-1", declaredAt: at };
const cr = (d: string) => ({ outcomeKey: "company_researched", subjectId: d, declaredAt: at });

describe("planRunCorrection", () => {
  it("takes back a company nobody produced and re-declares the produced one at the original instant", () => {
    const plan = planRunCorrection(
      { runId: "r1", serviceName: "workflow", storedDomains: ["acme.com", "ghost.com"], ledgerConsumed: [lead, cr("acme.com"), cr("ghost.com")] },
      new Map([["acme.com", "2026-08-30T00:00:00.000Z"]]),
    );
    expect(plan).toEqual({ kind: "take_back", runId: "r1", serviceName: "workflow", consumedAt: at, takeBack: ["ghost.com"], desired: ["acme.com"], missing: [] });
  });

  it("a production declared after the end of the consumption's UTC day does not count (runs-service's resolution)", () => {
    const sameDay = planRunCorrection({ runId: "r", serviceName: "s", storedDomains: ["a.com"], ledgerConsumed: [cr("a.com")] }, new Map([["a.com", "2026-09-01T23:59:00.000Z"]]));
    expect(sameDay.kind).toBe("none");
    const nextDay = planRunCorrection({ runId: "r", serviceName: "s", storedDomains: ["a.com"], ledgerConsumed: [cr("a.com")] }, new Map([["a.com", "2026-09-02T00:00:00.000Z"]]));
    expect(nextDay).toMatchObject({ kind: "take_back", takeBack: ["a.com"], desired: [] });
  });

  it("re-runnable: after the void, a crash before the re-declaration declares only the missing one; a finished run plans nothing", () => {
    const produced = new Map([["acme.com", "2026-08-30T00:00:00.000Z"]]);
    expect(planRunCorrection({ runId: "r", serviceName: "s", storedDomains: ["acme.com", "ghost.com"], ledgerConsumed: [lead] }, produced)).toMatchObject({
      kind: "declare_missing",
      missing: ["acme.com"],
      takeBack: [],
    });
    expect(planRunCorrection({ runId: "r", serviceName: "s", storedDomains: ["acme.com", "ghost.com"], ledgerConsumed: [lead, cr("acme.com")] }, produced).kind).toBe("none");
  });

  it("a run with nothing on the ledger is unreadable, never declared on a guess", () => {
    expect(planRunCorrection({ runId: "r", serviceName: "s", storedDomains: ["a.com"], ledgerConsumed: [] }, new Map()).kind).toBe("unreadable");
  });

  it("endOfUtcDay is the next UTC midnight", () => {
    expect(endOfUtcDay(new Date("2026-09-01T23:59:59.999Z"))).toBe("2026-09-02T00:00:00.000Z");
  });
});
