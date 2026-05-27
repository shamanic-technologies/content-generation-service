import { describe, it, expect, vi, beforeEach } from "vitest";

const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
const insert = vi.fn().mockReturnValue({ values });

vi.mock("../../src/db/index.js", () => ({
  db: { insert: (...args: unknown[]) => insert(...args) },
}));

vi.mock("../../src/db/schema.js", () => ({
  prompts: { __table: "prompts", type: { __col: "type" } },
}));

import { prompts } from "../../src/db/schema.js";
import {
  EXPERT_QUOTE_PITCH_TYPE,
  EXPERT_QUOTE_PITCH_TEMPLATE,
  EXPERT_QUOTE_PITCH_VARIABLES,
} from "../../src/lib/expert-quote-pitch-template.js";
import { registerPlatformTemplates } from "../../src/lib/register-platform-templates.js";

describe("registerPlatformTemplates", () => {
  beforeEach(() => {
    insert.mockClear();
    values.mockClear();
    onConflictDoUpdate.mockClear();
  });

  it("upserts the expert-quote-pitch template against prompts.type with the source-of-truth body and variables", async () => {
    await registerPlatformTemplates();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(prompts);

    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith({
      orgId: null,
      type: EXPERT_QUOTE_PITCH_TYPE,
      prompt: EXPERT_QUOTE_PITCH_TEMPLATE,
      variables: EXPERT_QUOTE_PITCH_VARIABLES,
    });

    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    const arg = onConflictDoUpdate.mock.calls[0][0];
    expect(arg.target).toBe(prompts.type);
    expect(arg.set.prompt).toBe(EXPERT_QUOTE_PITCH_TEMPLATE);
    expect(arg.set.variables).toBe(EXPERT_QUOTE_PITCH_VARIABLES);
    expect(arg.set.updatedAt).toBeInstanceOf(Date);
  });

  it("awaits every upsert before resolving", async () => {
    let resolveUpsert: () => void = () => {};
    onConflictDoUpdate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveUpsert = resolve;
      })
    );

    let resolved = false;
    const pending = registerPlatformTemplates().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveUpsert();
    await pending;
    expect(resolved).toBe(true);
  });

  it("calls the boot reconcile path once per registered platform template (currently 1)", async () => {
    await registerPlatformTemplates();
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
