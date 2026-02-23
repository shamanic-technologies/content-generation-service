import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Shared header param
// ---------------------------------------------------------------------------
const ClerkOrgIdHeader = registry.registerParameter(
  "ClerkOrgId",
  z.string().openapi({ param: { name: "X-Clerk-Org-Id", in: "header" } })
);

// ---------------------------------------------------------------------------
// Error response
// ---------------------------------------------------------------------------
const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z.object({ error: z.string() }).openapi("ErrorResponse")
);

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
const HealthResponseSchema = registry.register(
  "HealthResponse",
  z
    .object({
      status: z.string(),
      service: z.string(),
    })
    .openapi("HealthResponse")
);

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// PUT /prompts — Upsert a prompt template for an app
// ---------------------------------------------------------------------------
export const UpsertPromptRequestSchema = registry.register(
  "UpsertPromptRequest",
  z
    .object({
      appId: z.string(),
      type: z.string().describe("Prompt type, e.g. 'email' or 'calendar'"),
      prompt: z.string().describe("Prompt template text with {{variable}} placeholders"),
      variables: z.array(z.string()).describe("List of expected variable names used in the prompt"),
    })
    .openapi("UpsertPromptRequest")
);

const UpsertPromptResponseSchema = registry.register(
  "UpsertPromptResponse",
  z
    .object({
      id: z.string(),
      appId: z.string(),
      type: z.string(),
      variables: z.array(z.string()),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi("UpsertPromptResponse")
);

registry.registerPath({
  method: "put",
  path: "/prompts",
  tags: ["Prompts"],
  summary: "Register or update a prompt template for an app (idempotent)",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpsertPromptRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Prompt upserted",
      content: { "application/json": { schema: UpsertPromptResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /generate — Generate content using a stored prompt + variables
// ---------------------------------------------------------------------------
export const GenerateRequestSchema = registry.register(
  "GenerateRequest",
  z
    .object({
      appId: z.string(),
      type: z.string().describe("Which stored prompt to use, e.g. 'email' or 'calendar'"),
      variables: z.record(z.string(), z.unknown()).describe("Variable values to substitute into the prompt template. Non-string values (arrays, objects) are coerced to strings."),
      keyMode: z.enum(["byok", "app"]),
      // Tracking / linking
      runId: z.string(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      apolloEnrichmentId: z.string().optional(),
      idempotencyKey: z.string().optional(),
      workflowName: z.string().optional(),
      aiDisclaimer: z.boolean().optional().default(false).describe("When true, appends a small AI-generated disclaimer to the email body"),
    })
    .openapi("GenerateRequest")
);

const SequenceStepSchema = z.object({
  step: z.number(),
  bodyHtml: z.string(),
  bodyText: z.string(),
  daysSinceLastStep: z.number(),
});

const GenerateResponseSchema = registry.register(
  "GenerateResponse",
  z
    .object({
      id: z.string(),
      subject: z.string(),
      sequence: z.array(SequenceStepSchema),
      tokensInput: z.number(),
      tokensOutput: z.number(),
    })
    .openapi("GenerateResponse")
);

registry.registerPath({
  method: "post",
  path: "/generate",
  tags: ["Content Generation"],
  summary: "Generate content using a stored prompt template with variable substitution",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: GenerateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Generated content",
      content: { "application/json": { schema: GenerateResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Prompt not found for this app + type",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /generations?runId&campaignId&appId&brandId
// ---------------------------------------------------------------------------
const GenerationsListResponseSchema = registry.register(
  "GenerationsListResponse",
  z
    .object({
      generations: z.array(z.object({}).passthrough()),
    })
    .openapi("GenerationsListResponse")
);

registry.registerPath({
  method: "get",
  path: "/generations",
  tags: ["Content Generation"],
  summary: "List generations with filters",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    query: z.object({
      runId: z.string().optional(),
      campaignId: z.string().optional(),
      appId: z.string().optional(),
      brandId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of generations",
      content: {
        "application/json": { schema: GenerationsListResponseSchema },
      },
    },
    400: {
      description: "At least one filter required",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /generations/by-enrichment/:apolloEnrichmentId
// ---------------------------------------------------------------------------
const GenerationSingleResponseSchema = registry.register(
  "GenerationSingleResponse",
  z
    .object({
      generation: z.object({}).passthrough(),
    })
    .openapi("GenerationSingleResponse")
);

registry.registerPath({
  method: "get",
  path: "/generations/by-enrichment/{apolloEnrichmentId}",
  tags: ["Content Generation"],
  summary: "Get generation by enrichment ID",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    params: z.object({ apolloEnrichmentId: z.string() }),
  },
  responses: {
    200: {
      description: "Content generation",
      content: {
        "application/json": { schema: GenerationSingleResponseSchema },
      },
    },
    404: {
      description: "Generation not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /generate/content
// ---------------------------------------------------------------------------
export const GenerateContentRequestSchema = registry.register(
  "GenerateContentRequest",
  z
    .object({
      appId: z.string(),
      prompt: z.string(),
      variables: z.array(z.string()).optional(),
      includeFooter: z.boolean().optional().default(false),
      aiDisclaimer: z.boolean().optional().default(false).describe("When true, appends a small AI-generated disclaimer to the email body"),
      keyMode: z.enum(["byok", "app"]),
      parentRunId: z.string().optional(),
      workflowName: z.string().optional(),
    })
    .openapi("GenerateContentRequest")
);

const GenerateContentResponseSchema = registry.register(
  "GenerateContentResponse",
  z
    .object({
      id: z.string(),
      subject: z.string(),
      bodyHtml: z.string(),
      bodyText: z.string(),
      tokensInput: z.number(),
      tokensOutput: z.number(),
    })
    .openapi("GenerateContentResponse")
);

registry.registerPath({
  method: "post",
  path: "/generate/content",
  tags: ["Content Generation"],
  summary: "Generate email content from a free-text prompt",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: GenerateContentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Generated email content",
      content: { "application/json": { schema: GenerateContentResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /generate/calendar
// ---------------------------------------------------------------------------
export const GenerateCalendarRequestSchema = registry.register(
  "GenerateCalendarRequest",
  z
    .object({
      appId: z.string(),
      prompt: z.string(),
      keyMode: z.enum(["byok", "app"]),
      parentRunId: z.string().optional(),
      workflowName: z.string().optional(),
    })
    .openapi("GenerateCalendarRequest")
);

const GenerateCalendarResponseSchema = registry.register(
  "GenerateCalendarResponse",
  z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      location: z.string().nullable(),
      tokensInput: z.number(),
      tokensOutput: z.number(),
    })
    .openapi("GenerateCalendarResponse")
);

registry.registerPath({
  method: "post",
  path: "/generate/calendar",
  tags: ["Content Generation"],
  summary: "Generate calendar event fields from a free-text prompt",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: GenerateCalendarRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Generated calendar event",
      content: { "application/json": { schema: GenerateCalendarResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /stats
// ---------------------------------------------------------------------------
export const StatsRequestSchema = registry.register(
  "StatsRequest",
  z
    .object({
      runIds: z.array(z.string()).optional(),
      appId: z.string().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
    })
    .openapi("StatsRequest")
);

const StatsResponseSchema = registry.register(
  "StatsResponse",
  z
    .object({
      stats: z.object({
        emailsGenerated: z.number(),
      }),
    })
    .openapi("StatsResponse")
);

registry.registerPath({
  method: "post",
  path: "/stats",
  tags: ["Stats"],
  summary: "Get aggregated stats by filters",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: StatsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
    400: {
      description: "Missing required fields",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /stats/by-model
// ---------------------------------------------------------------------------
export const StatsByModelRequestSchema = registry.register(
  "StatsByModelRequest",
  z
    .object({
      runIds: z.array(z.string()).optional(),
      clerkOrgId: z.string().optional(),
      appId: z.string().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
    })
    .openapi("StatsByModelRequest")
);

const StatsByModelResponseSchema = registry.register(
  "StatsByModelResponse",
  z
    .object({
      stats: z.array(
        z.object({
          model: z.string(),
          count: z.number(),
          runIds: z.array(z.string()),
        })
      ),
    })
    .openapi("StatsByModelResponse")
);

registry.registerPath({
  method: "post",
  path: "/stats/by-model",
  tags: ["Stats"],
  summary: "Get content generation stats grouped by model (internal)",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: StatsByModelRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Stats grouped by model",
      content: {
        "application/json": { schema: StatsByModelResponseSchema },
      },
    },
    400: {
      description: "Missing required fields",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
