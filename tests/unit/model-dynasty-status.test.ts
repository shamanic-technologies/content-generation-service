import { describe, it, expect } from "vitest";
import {
  dynastyMembers,
  dynastyStatusAlignment,
  effectiveDynastyPipeRows,
  type PipeStatusRow,
} from "../../src/lib/model-dynasty-status.js";

const CATALOGUE = [
  { model: "kimi-k3", dynasty: "kimi-k3" },
  { model: "kimi-pro", dynasty: "kimi-k3" },
  { model: "kimi-k2", dynasty: "kimi-k2" },
  { model: "solo", dynasty: null },
];
const REPLY = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" };
const VISIT = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit" };

const row = (model: string, pipe: typeof REPLY, status: "active" | "deprecated", at: string): PipeStatusRow => ({
  model, ...pipe, status, statusChangedAt: new Date(at),
  statusReason: status === "deprecated" ? "Too expensive" : null, statusChangedBy: "kevin@distribute.you",
});

describe("model dynasty status (LLM-DYNASTY-DEPRECATE-1025)", () => {
  it("members = every name of the dynasty; a dynasty-less name is alone", () => {
    expect(dynastyMembers(CATALOGUE, { model: "kimi-pro", dynasty: "kimi-k3" })).toEqual(["kimi-k3", "kimi-pro"]);
    expect(dynastyMembers(CATALOGUE, { model: "solo", dynasty: null })).toEqual(["solo"]);
  });

  it("a dynasty's status on a pipe = its latest change on that pipe, whichever name", () => {
    const eff = effectiveDynastyPipeRows(CATALOGUE, [
      row("kimi-pro", REPLY, "deprecated", "2026-10-24T10:00:00Z"),
      row("kimi-k3", REPLY, "active", "2026-10-20T10:00:00Z"),
      row("kimi-k3", VISIT, "deprecated", "2026-10-21T10:00:00Z"),
    ]);
    const k3 = eff.get("kimi-k3")!;
    expect(k3.map((r) => [r.legKey, r.status])).toEqual([
      ["lead_found_to_website_visit", "deprecated"],
      ["lead_found_to_conversation", "deprecated"],
    ]);
    expect(eff.get("kimi-k2")).toBeUndefined();
  });

  it("alignment writes the missing/different sibling rows, then nothing", () => {
    const rows = [row("kimi-pro", REPLY, "deprecated", "2026-10-24T10:00:00Z"), row("kimi-k3", REPLY, "active", "2026-10-20T10:00:00Z")];
    const writes = dynastyStatusAlignment(CATALOGUE, rows);
    expect(writes).toEqual([{ ...rows[0], model: "kimi-k3" }]);
    expect(dynastyStatusAlignment(CATALOGUE, [rows[0], ...writes])).toEqual([]);
  });
});
