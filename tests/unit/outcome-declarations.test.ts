import { describe, it, expect, vi, beforeEach } from "vitest";

// The stored declaration is sent, marked on success, marked refused on a permanent 4xx, and left
// pending (for the sweep) on anything else. The db is a tagged-template stub recording each query.
const queries: Array<{ text: string; values: unknown[] }> = [];
let selectRows: unknown[] = [];
let renderRows: unknown[] = [];
vi.mock("../../src/db/index.js", () => {
  const sql = (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === "string") return { identifier: strings };
    const text = strings.join("?");
    queries.push({ text, values });
    if (!text.trim().startsWith("SELECT")) return Promise.resolve([]);
    return Promise.resolve(text.includes("industry_debrief_videos") ? renderRows : selectRows);
  };
  return { sql, db: {} };
});
const mockPost = vi.fn();
vi.mock("../../src/lib/run-outcomes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/run-outcomes.js")>();
  return { ...actual, postRunOutcomes: (...a: unknown[]) => mockPost(...a) };
});

const mockProduced = vi.fn();
vi.mock("../../src/lib/company-research-ledger.js", () => ({ producedResearchDomains: (...a: unknown[]) => mockProduced(...a) }));

const { declareStoredOutcomes, declareRenderOutcomes, sweepPendingOutcomes } = await vi.importActual<typeof import("../../src/lib/outcome-declarations.js")>(
  "../../src/lib/outcome-declarations.js",
);
const { PermanentDeclarationError } = await import("../../src/lib/run-outcomes.js");

const row = { id: "gen-1", org_id: "org-1", generation_run_id: "run-9", outcomes: { produced: [], consumed: [] }, created_at: "2026-10-24 10:00:00+00" };

describe("outcome declarations", () => {
  beforeEach(() => {
    queries.length = 0;
    selectRows = [row];
    renderRows = [];
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
    expect(totals).toEqual({ declared: 2, refused: 0, failed: 0, waiting: 0 });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  describe("company_researched only when lead-service produced it (COMPANY-RESEARCHED-PROVENANCE-1024)", () => {
    const lead = { outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" };
    const cr = (d: string) => ({ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: d });
    const withResearch = (createdAt: string) => ({
      ...row,
      created_at: createdAt,
      outcomes: { produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }], consumed: [lead, cr("acme.com")] },
    });
    beforeEach(() => {
      mockProduced.mockReset();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("a company on the ledger is consumed as stored", async () => {
      selectRows = [withResearch("2026-10-24 10:00:00+00")];
      mockProduced.mockResolvedValue(new Set(["acme.com"]));
      mockPost.mockResolvedValue(201);
      await declareStoredOutcomes("email_generations", "gen-1");
      expect(mockProduced).toHaveBeenCalledWith(["acme.com"]);
      expect(mockPost.mock.calls[0][2].consumed).toEqual([lead, cr("acme.com")]);
    });

    it("a company nobody produced is dropped once the grace is over, and the stored body says what was sent", async () => {
      selectRows = [withResearch("2026-10-01 10:00:00+00")];
      mockProduced.mockResolvedValue(new Set());
      mockPost.mockResolvedValue(201);
      await declareStoredOutcomes("email_generations", "gen-1");
      expect(mockPost.mock.calls[0][2].consumed).toEqual([lead]);
      const update = queries.find((q) => q.text.includes("outcomes_declared_at = now()"))!;
      expect(JSON.parse(update.values.find((v) => typeof v === "string" && v.includes("consumed")) as string).consumed).toEqual([lead]);
    });

    it("a fresh row waits for lead-service's declaration (nothing sent, nothing marked)", async () => {
      selectRows = [withResearch(new Date().toISOString())];
      mockProduced.mockResolvedValue(new Set());
      const totals = await sweepPendingOutcomes();
      expect(totals.waiting).toBe(2);
      expect(mockPost).not.toHaveBeenCalled();
      expect(queries.filter((q) => q.text.trim().startsWith("UPDATE"))).toHaveLength(0);
    });

    it("an unreadable ledger leaves the row pending (never declared on a guess)", async () => {
      selectRows = [withResearch("2026-10-01 10:00:00+00")];
      mockProduced.mockRejectedValue(new Error("runs-service 502"));
      await declareStoredOutcomes("email_generations", "gen-1");
      expect(mockPost).not.toHaveBeenCalled();
      expect(queries.filter((q) => q.text.trim().startsWith("UPDATE"))).toHaveLength(0);
    });
  });

  describe("industry debrief videos (LEDGER-HISTORY-1024)", () => {
    const render = { id: "rend-1", org_id: "org-1", run_id: "run-r", finished_at: "2026-10-12 09:31:02.123456+00" };

    it("a done render produces industry_update_video on its own run, dated when it was delivered", async () => {
      renderRows = [render];
      mockPost.mockResolvedValue(201);
      await declareRenderOutcomes("rend-1");
      expect(mockPost).toHaveBeenCalledWith(
        "run-r",
        "org-1",
        { produced: [{ outcomeKey: "industry_update_video", subjectService: "content-generation-service", subjectId: "rend-1" }], consumed: [] },
        "2026-10-12T09:31:02.123Z",
      );
      expect(queries.some((q) => q.text.includes("UPDATE industry_debrief_videos SET outcomes_declared_at = now()"))).toBe(true);
    });

    it("only done renders not yet handled are read (a failed render is a run with no output)", async () => {
      renderRows = [];
      await declareRenderOutcomes("rend-1");
      expect(mockPost).not.toHaveBeenCalled();
      const read = queries.find((q) => q.text.includes("FROM industry_debrief_videos"))!;
      expect(read.text).toContain("status = 'done'");
      expect(read.text).toContain("outcomes_declared_at IS NULL AND outcomes_error IS NULL");
    });

    it("a dry run or a render with no campaign is never read: a staff test, not an outcome (DRY-RUN-RENDER-1024)", async () => {
      await sweepPendingOutcomes();
      const read = queries.find((q) => q.text.includes("FROM industry_debrief_videos"))!;
      expect(read.text).toContain("COALESCE(request->>'dryRun', 'false') <> 'true'");
      expect(read.text).toContain("COALESCE(tracking->>'campaignId', '') <> ''");
    });

    it("a refusal is stored on the render, never retried", async () => {
      renderRows = [render];
      mockPost.mockRejectedValue(new PermanentDeclarationError(400, "unknown_outcome_key"));
      await declareRenderOutcomes("rend-1");
      expect(queries.some((q) => q.text.includes("UPDATE industry_debrief_videos SET outcomes_error ="))).toBe(true);
    });

    it("the sweep sends pending renders too", async () => {
      renderRows = [render];
      mockPost.mockResolvedValue(201);
      const totals = await sweepPendingOutcomes();
      expect(totals).toEqual({ declared: 3, refused: 0, failed: 0, waiting: 0 });
    });
  });
});
