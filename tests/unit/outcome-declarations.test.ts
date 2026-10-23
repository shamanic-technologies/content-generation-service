import { describe, it, expect, vi, beforeEach } from "vitest";

// The stored declaration is sent, marked on success, marked refused on a permanent 4xx, and left
// pending (for the sweep) on anything else. The db is a tagged-template stub recording each query.
const queries: Array<{ text: string; values: unknown[] }> = [];
let selectRows: unknown[] = [];
vi.mock("../../src/db/index.js", () => {
  const sql = (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === "string") return { identifier: strings };
    const text = strings.join("?");
    queries.push({ text, values });
    return Promise.resolve(text.trim().startsWith("SELECT") ? selectRows : []);
  };
  return { sql, db: {} };
});
const mockPost = vi.fn();
vi.mock("../../src/lib/run-outcomes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/run-outcomes.js")>();
  return { ...actual, postRunOutcomes: (...a: unknown[]) => mockPost(...a) };
});

const { declareStoredOutcomes, sweepPendingOutcomes } = await vi.importActual<typeof import("../../src/lib/outcome-declarations.js")>(
  "../../src/lib/outcome-declarations.js",
);
const { PermanentDeclarationError } = await import("../../src/lib/run-outcomes.js");

const row = { id: "gen-1", org_id: "org-1", generation_run_id: "run-9", outcomes: { produced: [], consumed: [] } };

describe("outcome declarations", () => {
  beforeEach(() => {
    queries.length = 0;
    selectRows = [row];
    mockPost.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("sends the stored body on the generation's run and marks it declared", async () => {
    mockPost.mockResolvedValue(201);
    await declareStoredOutcomes("email_generations", "gen-1");
    expect(mockPost).toHaveBeenCalledWith("run-9", "org-1", row.outcomes);
    expect(queries.some((q) => q.text.includes("outcomes_declared_at = now()"))).toBe(true);
  });

  it("a replay (200 already_recorded) is also declared", async () => {
    mockPost.mockResolvedValue(200);
    await declareStoredOutcomes("whatsapp_generations", "gen-1");
    expect(queries.some((q) => q.text.includes("outcomes_declared_at = now()"))).toBe(true);
  });

  it("a permanent refusal is stored as the error, never retried", async () => {
    mockPost.mockRejectedValue(new PermanentDeclarationError(400, "unknown_outcome_key"));
    await declareStoredOutcomes("email_generations", "gen-1");
    expect(queries.some((q) => q.text.includes("outcomes_error ="))).toBe(true);
    expect(queries.some((q) => q.text.includes("outcomes_declared_at = now()"))).toBe(false);
  });

  it("a transient failure leaves the row pending and never throws", async () => {
    mockPost.mockRejectedValue(new Error("502"));
    await expect(declareStoredOutcomes("email_generations", "gen-1")).resolves.toBeUndefined();
    expect(queries.filter((q) => q.text.trim().startsWith("UPDATE"))).toHaveLength(0);
  });

  it("the sweep sends every pending row of both tables", async () => {
    mockPost.mockResolvedValue(201);
    const totals = await sweepPendingOutcomes();
    expect(totals).toEqual({ declared: 2, refused: 0, failed: 0 });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
