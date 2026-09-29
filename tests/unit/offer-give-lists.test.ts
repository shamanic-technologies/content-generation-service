import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseOfferGiveLists,
  buildGiveListsDirective,
  giveListsFingerprint,
  hasGiveLists,
  EMPTY_GIVE_LISTS,
} from "../../src/lib/offer-give-lists.js";
import { fetchOfferGiveLists, OfferGiveListsError } from "../../src/lib/offer-give-lists-client.js";
import { generateFromTemplate } from "../../src/lib/chat-service-client.js";

describe("parseOfferGiveLists", () => {
  it("reads confirmed lists only, trimmed and de-duplicated", () => {
    const view = {
      fields: {
        giveForFree: { value: [" A free audit ", "", "A free audit", "A 14-day trial"], provenance: "confirmed" },
        neverGive: { value: ["Discounts"], provenance: "confirmed" },
        dreamOutcome: { value: "x", provenance: "confirmed" },
      },
    };
    expect(parseOfferGiveLists(view)).toEqual({ giveForFree: ["A free audit", "A 14-day trial"], neverGive: ["Discounts"] });
  });

  it("never uses a suggested (auto-extracted) list: the customer did not state it", () => {
    const view = {
      fields: {
        giveForFree: { value: ["A free audit"], provenance: "suggested" },
        neverGive: { value: null, provenance: "suggested" },
      },
    };
    expect(parseOfferGiveLists(view)).toEqual(EMPTY_GIVE_LISTS);
  });

  it("reads an unknown or empty view as no lists", () => {
    expect(parseOfferGiveLists(undefined)).toEqual(EMPTY_GIVE_LISTS);
    expect(parseOfferGiveLists({ fields: {} })).toEqual(EMPTY_GIVE_LISTS);
    expect(parseOfferGiveLists({ fields: { giveForFree: { value: [], provenance: "confirmed" } } })).toEqual(EMPTY_GIVE_LISTS);
  });
});

describe("buildGiveListsDirective", () => {
  it("is empty when both lists are empty, so nothing about the prompt changes", () => {
    expect(buildGiveListsDirective(EMPTY_GIVE_LISTS)).toBe("");
    expect(hasGiveLists(EMPTY_GIVE_LISTS)).toBe(false);
  });

  it("makes a free-give item the ask and lists every won't-give item as forbidden", () => {
    const d = buildGiveListsDirective({ giveForFree: ["A free pipeline audit"], neverGive: ["Discounts", "Free implementation"] });
    expect(d).toContain("  - A free pipeline audit");
    expect(d).toMatch(/Make ONE of these the ask of the first email/);
    expect(d).toContain("  - Discounts");
    expect(d).toContain("  - Free implementation");
    expect(d).toMatch(/NEVER give/);
  });

  it("states only the list that exists", () => {
    const onlyNever = buildGiveListsDirective({ giveForFree: [], neverGive: ["Discounts"] });
    expect(onlyNever).not.toMatch(/the ask of the first email/);
    expect(onlyNever).toContain("  - Discounts");
    const onlyFree = buildGiveListsDirective({ giveForFree: ["A trial"], neverGive: [] });
    expect(onlyFree).not.toMatch(/NEVER give/);
  });
});

describe("giveListsFingerprint", () => {
  it("is empty for no lists and stable across case and spacing", () => {
    expect(giveListsFingerprint(null)).toBe("");
    expect(giveListsFingerprint(EMPTY_GIVE_LISTS)).toBe("");
    expect(giveListsFingerprint({ giveForFree: ["A  Free audit"], neverGive: [] })).toBe(
      giveListsFingerprint({ giveForFree: ["a free audit"], neverGive: [] })
    );
  });
});

describe("fetchOfferGiveLists", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const base = { orgId: "org-1", userId: "user-1", runId: "run-1" };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads the named offer's user-fields and keeps the confirmed lists", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      fields: { giveForFree: { value: ["A free audit"], provenance: "confirmed" }, neverGive: { value: null, provenance: "suggested" } },
    }), { status: 200 }));
    const lists = await fetchOfferGiveLists({ ...base, brandId: "b-1", offerId: "o-1" });
    expect(lists).toEqual({ giveForFree: ["A free audit"], neverGive: [] });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/orgs\/brands\/b-1\/offers\/o-1\/user-fields$/);
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "x-org-id": "org-1", "x-brand-id": "b-1" });
  });

  it("reads the brand's sole offer when no offer is named", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ fields: {} }), { status: 200 }));
    await fetchOfferGiveLists({ ...base, brandId: "b-1" });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/orgs\/brands\/b-1\/user-fields$/);
  });

  it("reads nothing for a multi-brand or brandless request", async () => {
    await expect(fetchOfferGiveLists({ ...base, brandId: "b-1,b-2", offerId: "o-1" })).resolves.toBeNull();
    await expect(fetchOfferGiveLists(base)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws brand-service's refusal with its status", async () => {
    fetchSpy.mockResolvedValue(new Response("SEVERAL_OFFERS", { status: 409 }));
    await expect(fetchOfferGiveLists({ ...base, brandId: "b-1" })).rejects.toMatchObject({ status: 409 });
    fetchSpy.mockResolvedValue(new Response("no", { status: 404 }));
    await expect(fetchOfferGiveLists({ ...base, brandId: "b-1" })).rejects.toBeInstanceOf(OfferGiveListsError);
  });
});

describe("generateFromTemplate with give lists", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const ok = () => new Response(JSON.stringify({
    content: "{}",
    json: { subject: "s", emails: [{ body: "Hi", daysSinceLastStep: 0 }] },
    tokensInput: 1,
    tokensOutput: 1,
    model: "m",
  }), { status: 200 });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  async function systemPromptFor(giveLists: Parameters<typeof generateFromTemplate>[0]["giveLists"]) {
    fetchSpy.mockResolvedValueOnce(ok());
    await generateFromTemplate({ promptTemplate: "Write.", variables: {}, giveLists }, { orgId: "o", userId: "u", runId: "r" });
    return JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string).systemPrompt as string;
  }

  it("leaves the system prompt byte-identical when the lists are absent or empty", async () => {
    const none = await systemPromptFor(undefined);
    expect(await systemPromptFor(null)).toBe(none);
    expect(await systemPromptFor(EMPTY_GIVE_LISTS)).toBe(none);
  });

  it("appends the rule when a list is set", async () => {
    const none = await systemPromptFor(undefined);
    const lists = { giveForFree: ["A free audit"], neverGive: ["Discounts"] };
    expect(await systemPromptFor(lists)).toBe(`${none}\n${buildGiveListsDirective(lists)}`);
  });
});
