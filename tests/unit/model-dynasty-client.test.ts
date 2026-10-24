import { describe, it, expect, vi, afterEach } from "vitest";

const { resolveModelDynastyVersions, ModelDynastyNotFoundError, ModelDynastyCatalogueError } = await import("../../src/lib/model-dynasty-client.js");

const BODY = {
  dynasties: [
    {
      slug: "gemini-pro", name: "Gemini Pro", headModelId: "gemini-3.1-pro-preview",
      models: [{ modelId: "gemini-3.1-pro-preview" }, { modelId: "gemini-2.5-pro" }], legacyAliases: ["pro"],
    },
  ],
};

function stubFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("resolveModelDynastyVersions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads every concrete model id of the dynasty, head first", async () => {
    const f = stubFetch(200, BODY);
    expect(await resolveModelDynastyVersions("gemini-pro")).toEqual({
      slug: "gemini-pro", name: "Gemini Pro", modelIds: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
    });
    expect(String(f.mock.calls[0][0])).toMatch(/\/internal\/model-dynasties$/);
  });

  it("an unknown dynasty is a not-found, an unreadable catalogue a loud failure", async () => {
    stubFetch(200, BODY);
    await expect(resolveModelDynastyVersions("nope")).rejects.toBeInstanceOf(ModelDynastyNotFoundError);
    vi.restoreAllMocks();
    stubFetch(200, { nothing: true });
    await expect(resolveModelDynastyVersions("gemini-pro")).rejects.toBeInstanceOf(ModelDynastyCatalogueError);
  });
});
