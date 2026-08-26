import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getLeadLanguages } from "../../src/lib/lead-client.js";

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("getLeadLanguages", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the ordered list off the leadDetail wrapper", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ leadDetail: { lead: { languages: ["German", "English"] } } })
    );
    await expect(getLeadLanguages("lead-1", identity)).resolves.toEqual(["German", "English"]);
  });

  it("also accepts a bare lead payload, so a wrapper change does not silently drop the field", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ lead: { languages: ["Italian"] } }));
    await expect(getLeadLanguages("lead-1", identity)).resolves.toEqual(["Italian"]);

    fetchSpy.mockResolvedValue(jsonResponse({ languages: ["Dutch"] }));
    await expect(getLeadLanguages("lead-1", identity)).resolves.toEqual(["Dutch"]);
  });

  it("preserves order — selection downstream is by position", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ leadDetail: { lead: { languages: ["French", "Dutch"] } } })
    );
    await expect(getLeadLanguages("lead-1", identity)).resolves.toEqual(["French", "Dutch"]);
  });

  it("returns null when the lead reports no languages", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ leadDetail: { lead: { languages: [] } } }));
    await expect(getLeadLanguages("lead-1", identity)).resolves.toBeNull();
  });

  it("returns null when the field is absent entirely (producer has not shipped it yet)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ leadDetail: { lead: { firstName: "Ada" } } }));
    await expect(getLeadLanguages("lead-1", identity)).resolves.toBeNull();
  });

  it("degrades to null and logs when lead-service answers non-2xx", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(getLeadLanguages("lead-1", identity)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("degrades to null and logs when lead-service is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("boom"));
    await expect(getLeadLanguages("lead-1", identity)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("degrades to null and logs when the body is unreadable", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response);
    await expect(getLeadLanguages("lead-1", identity)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("forwards identity + tracking headers to lead-service", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ leadDetail: { lead: { languages: [] } } }));
    await getLeadLanguages("lead-1", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      campaignId: "camp-1",
      audienceId: "aud-1",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/orgs/leads/lead-1");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-audience-id"]).toBe("aud-1");
  });

  it("url-encodes the lead id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ leadDetail: { lead: { languages: [] } } }));
    await getLeadLanguages("a/b", identity);
    expect(fetchSpy.mock.calls[0][0]).toContain("/orgs/leads/a%2Fb");
  });
});
