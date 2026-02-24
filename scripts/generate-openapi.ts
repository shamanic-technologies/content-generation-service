import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import * as fs from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Content Generation Service",
    description: "AI-powered content generation service",
    version: "1.0.0",
  },
  servers: [
    {
      url:
        process.env.CONTENT_GENERATION_SERVICE_URL ||
        "https://content-generation.mcpfactory.org",
    },
  ],
  security: [{ ApiKeyAuth: [] }],
});

// Inject securitySchemes (zod-to-openapi doesn't support components.securitySchemes natively)
(document as any).components = {
  ...(document as any).components,
  securitySchemes: {
    ApiKeyAuth: {
      type: "apiKey",
      in: "header",
      name: "X-Api-Key",
    },
  },
};

fs.writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
