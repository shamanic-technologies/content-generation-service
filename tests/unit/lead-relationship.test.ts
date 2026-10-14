import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildLeadRelationshipBlock,
  buildLeadRelationshipDirective,
  normalizeLeadRelationship,
} from "../../src/lib/lead-relationship.js";
import { buildCampaignInstructionDirective } from "../../src/lib/campaign-instruction.js";
import { LEAD_CONTEXT_VARIABLES_PUBLISHED } from "../../src/lib/lead-context-variables.js";
import { generateFromTemplate } from "../../src/lib/chat-service-client.js";

const STRATEGY =
  "Someone the brand already knows must read a message from someone who knows them, continuing the relationship seen in the thread, in its language and tone.";

const KNOWN = {
  state: "known",
  known: true,
  judged: true,
  tags: ["personal"],
  unsureTags: [],
  lines: ["The owner knows them personally (a friend)."],
  hasThread: true,
  threadLines: [
    "2026-10-01 | whatsapp | THEM: On se voit jeudi ?",
    "2026-10-01 | whatsapp | US[Kevin]: Oui, a jeudi !",
  ],
  olderMessagesOmitted: 3,
  eventLines: ["2026-10-12 signed up to distribute.you"],
  strategy: STRATEGY,
};

const TEMPLATE = "Write a cold first-contact email to {{leadFirstName}} introducing our platform.";

describe("normalizeLeadRelationship", () => {
  it("reads absent, null, non-object or unknown state as nothing", () => {
    expect(normalizeLeadRelationship(undefined)).toBeNull();
    expect(normalizeLeadRelationship(null)).toBeNull();
    expect(normalizeLeadRelationship("known")).toBeNull();
    expect(normalizeLeadRelationship([])).toBeNull();
    expect(normalizeLeadRelationship({ state: "friend" })).toBeNull();
  });

  it("reads the producer's object", () => {
    const r = normalizeLeadRelationship(KNOWN)!;
    expect(r.state).toBe("known");
    expect(r.threadLines).toHaveLength(2);
    expect(r.olderMessagesOmitted).toBe(3);
    expect(r.strategy).toBe(STRATEGY);
  });
});

describe("buildLeadRelationshipBlock / Directive", () => {
  it("are empty without a relationship", () => {
    expect(buildLeadRelationshipBlock(null)).toBe("");
    expect(buildLeadRelationshipDirective(null)).toBe("");
  });

  it("a first contact says no message is on record", () => {
    const b = buildLeadRelationshipBlock(
      normalizeLeadRelationship({ state: "not_known", judged: true, hasThread: false, threadLines: [] })
    );
    expect(b).toContain("never exchanged a message");
    expect(b).toContain("No message between us and this person is on record.");
  });

  it("adds no em or en dash", () => {
    const rel = normalizeLeadRelationship(KNOWN);
    for (const text of [buildLeadRelationshipBlock(rel), buildLeadRelationshipDirective(rel)]) {
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it("is published with the context variables", () => {
    expect(LEAD_CONTEXT_VARIABLES_PUBLISHED.map((v) => v.name)).toContain("leadRelationship");
  });
});

describe("generateFromTemplate with leadRelationship", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const ok = () =>
    new Response(
      JSON.stringify({
        content: "{}",
        json: { subject: "s", emails: [{ body: "Hi", daysSinceLastStep: 0 }] },
        tokensInput: 1,
        tokensOutput: 1,
        model: "m",
      }),
      { status: 200 }
    );

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  async function sent(variables: Record<string, unknown>, instruction?: string) {
    fetchSpy.mockResolvedValueOnce(ok());
    await generateFromTemplate(
      { promptTemplate: TEMPLATE, variables, instruction },
      { orgId: "o", userId: "u", runId: "r" }
    );
    const body = JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
    return { message: body.message as string, systemPrompt: body.systemPrompt as string };
  }

  it("renders byte-identically when the variable is absent (or unusable)", async () => {
    const base = await sent({ leadFirstName: "Sam" });
    expect(base.message).toBe("Write a cold first-contact email to Sam introducing our platform.");
    expect(await sent({ leadFirstName: "Sam", leadRelationship: null })).toEqual(base);
    expect(await sent({ leadFirstName: "Sam", leadRelationship: { state: "nope" } })).toEqual(base);
  });

  it("a known person with a thread: relationship, thread and strategy reach the model, template body unchanged", async () => {
    const base = await sent({ leadFirstName: "Sam" });
    const { message, systemPrompt } = await sent({ leadFirstName: "Sam", leadRelationship: KNOWN });

    const rel = normalizeLeadRelationship(KNOWN);
    expect(message).toBe(`${buildLeadRelationshipBlock(rel)}\n\n${base.message}`);
    expect(message.endsWith("Write a cold first-contact email to Sam introducing our platform.")).toBe(true);
    expect(message).toContain("We ALREADY KNOW this person.");
    expect(message).toContain("The owner knows them personally (a friend).");
    expect(message).toContain("2026-10-01 | whatsapp | THEM: On se voit jeudi ?");
    expect(message).toContain("(3 older messages not shown)");
    expect(message).toContain("2026-10-12 signed up to distribute.you");
    // Tags are never shown to the writer as such.
    expect(message).not.toMatch(/\bpersonal\b/);

    expect(systemPrompt).toBe(`${base.systemPrompt}\n${buildLeadRelationshipDirective(rel)}`);
    expect(systemPrompt).toContain(STRATEGY);
    expect(systemPrompt).toMatch(/wins over the prompt above, the template's angle and framing/);
  });

  it("puts the strategy AFTER the campaign's instruction, so it wins", async () => {
    const instruction = "Write to a signup who never talked with us.";
    const { systemPrompt } = await sent({ leadFirstName: "Sam", leadRelationship: KNOWN }, instruction);
    const directive = buildCampaignInstructionDirective(instruction);
    expect(systemPrompt.indexOf(STRATEGY)).toBeGreaterThan(systemPrompt.indexOf(directive));
  });

  it("a template consuming {{leadRelationship}} keeps its rendering, no duplicate section", async () => {
    fetchSpy.mockResolvedValueOnce(ok());
    await generateFromTemplate(
      { promptTemplate: "Context: {{leadRelationship}}", variables: { leadRelationship: KNOWN } },
      { orgId: "o", userId: "u", runId: "r" }
    );
    const body = JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body.message).not.toContain("## Who this person already is to us");
    expect(body.systemPrompt).toContain(STRATEGY);
  });
});
