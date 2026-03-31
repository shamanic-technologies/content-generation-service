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

  it("warns about flat key format", () => {
    const desc: string =
      spec.components.schemas.GenerateRequest.properties.variables.description;
    expect(desc).toMatch(/flat/i);
  });
});
