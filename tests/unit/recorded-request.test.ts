import { describe, it, expect } from "vitest";
import { recordedText, readRecordedValues } from "../../src/lib/recorded-request.js";

// RECORDED-ORDER-1111: jsonb re-orders object keys; the recorded text keeps them as written.
describe("recorded text", () => {
  const variables = { leadEmploymentHistory: [{ organization_id: "o-1", organization_name: "Acme", title: "CEO", current: true, end_date: null }] };
  const request = { message: "m", systemPrompt: "s", responseSchema: { type: "object", properties: {} }, provider: "anthropic", model: "x" };

  it("round-trips every object with its original key order", () => {
    const text = recordedText({ variables, request, inputs: { promptTemplate: "t" }, response: { json: {} } });
    const v = readRecordedValues({ recordedText: text, variablesRaw: null, chatRequest: null, chatRequestInputs: null, responseRaw: null });
    expect(v.keyOrder).toBe("original");
    expect(JSON.stringify(v.variables)).toBe(JSON.stringify(variables));
    expect(JSON.stringify(v.request)).toBe(JSON.stringify(request));
  });

  it("falls back to the jsonb columns for a row written before", () => {
    const v = readRecordedValues({ recordedText: null, variablesRaw: variables, chatRequest: request, chatRequestInputs: { a: 1 }, responseRaw: { b: 2 } });
    expect(v).toEqual({ variables, request, inputs: { a: 1 }, response: { b: 2 }, keyOrder: "jsonb" });
  });
});
