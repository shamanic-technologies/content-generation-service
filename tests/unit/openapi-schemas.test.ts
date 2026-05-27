import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const spec = JSON.parse(
  readFileSync(resolve(__dirname, "../../openapi.json"), "utf-8")
);

describe("OpenAPI spec — EmailGeneration schema", () => {
  it("defines EmailGeneration as a named schema", () => {
    expect(spec.components.schemas).toHaveProperty("EmailGeneration");
  });

  it("includes all Drizzle columns in EmailGeneration", () => {
    const props = spec.components.schemas.EmailGeneration.properties;
    const expectedKeys = [
      "id", "orgId", "runId", "apolloEnrichmentId", "promptType",
      "leadFirstName", "leadLastName", "leadCompany", "leadTitle", "leadIndustry",
      "clientCompanyName", "clientCompanyDescription", "variablesRaw",
      "brandIds", "campaignId", "generationRunId",
      "subject", "bodyHtml", "bodyText", "sequence",
      "model", "tokensInput", "tokensOutput",
      "promptRaw", "responseRaw",
      "workflowSlug", "leadId", "idempotencyKey", "createdAt",
    ];
    for (const key of expectedKeys) {
      expect(props).toHaveProperty(key);
    }
  });

  it("GenerationsListResponse references EmailGeneration array", () => {
    const listSchema = spec.components.schemas.GenerationsListResponse;
    expect(listSchema.properties.generations.items.$ref).toContain(
      "EmailGeneration"
    );
  });

  it("GenerationSingleResponse references EmailGeneration", () => {
    const singleSchema = spec.components.schemas.GenerationSingleResponse;
    expect(singleSchema.properties.generation.$ref).toContain(
      "EmailGeneration"
    );
  });
});

describe("OpenAPI spec — POST /generate variables documentation", () => {
  it("documents recognised variable keys in the description", () => {
    const props = spec.components.schemas.GenerateRequest.properties;
    const desc: string = props.variables.description;
    const expectedKeys = [
      "leadFirstName", "leadLastName", "leadTitle",
      "leadCompanyName", "leadCompanyIndustry", "clientCompanyName",
    ];
    for (const key of expectedKeys) {
      expect(desc).toContain(key);
    }
  });

  it("documents multibrand input flexibility (no 'flat' prescription)", () => {
    const desc: string =
      spec.components.schemas.GenerateRequest.properties.variables.description;
    expect(desc).not.toMatch(/Keys must be flat/i);
    expect(desc.toLowerCase()).toMatch(/multibrand|arrays.*objects|any json/);
  });
});

describe("OpenAPI spec — POST /generate-expert-quote-pitch variables shape", () => {
  it("exposes `variables: Record<string, unknown>` (no strict brand/request)", () => {
    const props = spec.components.schemas.GenerateExpertQuotePitchRequest.properties;
    expect(props).toHaveProperty("variables");
    expect(props).not.toHaveProperty("brand");
    expect(props).not.toHaveProperty("request");
  });
});

describe("OpenAPI spec — PromptVariable shape", () => {
  it("defines PromptVariable as { name, description }", () => {
    expect(spec.components.schemas).toHaveProperty("PromptVariable");
    const props = spec.components.schemas.PromptVariable.properties;
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("description");
  });

  it("CreatePromptRequest.variables is an array of PromptVariable", () => {
    const props = spec.components.schemas.CreatePromptRequest.properties;
    expect(props.variables.type).toBe("array");
    expect(props.variables.items.$ref).toContain("PromptVariable");
  });
});
