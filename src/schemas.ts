import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Shared header params
// ---------------------------------------------------------------------------
const OrgIdHeader = registry.registerParameter(
  "OrgId",
  z.string().openapi({ param: { name: "X-Org-Id", in: "header" } })
);

const UserIdHeader = registry.registerParameter(
  "UserId",
  z.string().openapi({ param: { name: "X-User-Id", in: "header" } })
);

const RunIdHeader = registry.registerParameter(
  "RunId",
  z.string().openapi({ param: { name: "X-Run-Id", in: "header" } })
);

const CampaignIdHeader = registry.registerParameter(
  "CampaignId",
  z.string().optional().openapi({ param: { name: "X-Campaign-Id", in: "header", required: false, description: "Campaign ID injected by workflow-service" } })
);

const BrandIdHeader = registry.registerParameter(
  "BrandId",
  z.string().optional().openapi({ param: { name: "X-Brand-Id", in: "header", required: false, description: "Brand ID injected by workflow-service" } })
);

const WorkflowNameHeader = registry.registerParameter(
  "WorkflowName",
  z.string().optional().openapi({ param: { name: "X-Workflow-Name", in: "header", required: false, description: "Workflow name injected by workflow-service" } })
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
// Shared prompt schemas
// ---------------------------------------------------------------------------
export const CreatePromptRequestSchema = registry.register(
  "CreatePromptRequest",
  z
    .object({
      type: z.string().describe("Unique prompt identifier, e.g. 'cold-email' or 'welcome-email'"),
      prompt: z.string().describe("Prompt template text with {{variable}} placeholders. Must NOT contain company-specific data — only {{variables}}."),
      variables: z.array(z.string()).describe("List of expected variable names used in the prompt"),
    })
    .openapi("CreatePromptRequest")
);

export const VersionPromptRequestSchema = registry.register(
  "VersionPromptRequest",
  z
    .object({
      sourceType: z.string().describe("The type of the prompt to create a new version from, e.g. 'cold-email'"),
      prompt: z.string().describe("New prompt template text with {{variable}} placeholders. Must NOT contain company-specific data — only {{variables}}."),
      variables: z.array(z.string()).describe("List of expected variable names used in the prompt"),
    })
    .openapi("VersionPromptRequest")
);

const PromptResponseSchema = registry.register(
  "PromptResponse",
  z
    .object({
      id: z.string(),
      type: z.string(),
      prompt: z.string(),
      variables: z.array(z.string()),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi("PromptResponse")
);

// Keep old name as alias for backward compat in generate.ts import
export const UpsertPromptRequestSchema = CreatePromptRequestSchema;

// ---------------------------------------------------------------------------
// GET /prompts?type= — Read a prompt template (with identity headers)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/prompts",
  tags: ["Prompts"],
  summary: "Get a prompt template by type",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    query: z.object({ type: z.string().describe("Prompt type to look up") }),
  },
  responses: {
    200: {
      description: "Prompt found",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
    400: {
      description: "Missing type query param",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Prompt not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /platform-prompts?type= — Read a prompt template (no identity headers)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/platform-prompts",
  tags: ["Prompts"],
  summary: "Get a prompt template by type (no identity headers required)",
  request: {
    query: z.object({ type: z.string().describe("Prompt type to look up") }),
  },
  responses: {
    200: {
      description: "Prompt found",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
    400: {
      description: "Missing type query param",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Prompt not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /prompts — Idempotent prompt creation (with identity headers)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "post",
  path: "/prompts",
  tags: ["Prompts"],
  summary: "Create a prompt template (idempotent — no-op if type already exists)",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreatePromptRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Prompt created",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
    200: {
      description: "Prompt already exists (no-op)",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /platform-prompts — Idempotent prompt creation (no identity headers)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "post",
  path: "/platform-prompts",
  tags: ["Prompts"],
  summary: "Create a prompt template (idempotent — no-op if type already exists, no identity headers required)",
  description: "Used at cold start to register prompt templates. Same pattern as key-service POST /platform-keys.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreatePromptRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Prompt created",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
    200: {
      description: "Prompt already exists (no-op)",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// PUT /prompts — Create a new versioned prompt from an existing one
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "put",
  path: "/prompts",
  tags: ["Prompts"],
  summary: "Create or version a prompt (auto-increments type name if sourceType exists)",
  description:
    "If sourceType already exists, creates a new prompt with an auto-incremented type name. " +
    "E.g. sourceType 'cold-email' → creates 'cold-email-v2'. " +
    "sourceType 'cold-email-v5' → creates 'cold-email-v6'. " +
    "If sourceType does not exist, creates the prompt with that type directly. " +
    "The source prompt is never modified.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: VersionPromptRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "New versioned prompt created",
      content: { "application/json": { schema: PromptResponseSchema } },
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
      type: z.string().describe("Which stored prompt to use, e.g. 'cold-email' or 'welcome-email'"),
      variables: z.record(z.string(), z.unknown()).describe(
        "Variable values to substitute into the prompt template. " +
        "Non-string values (arrays, objects) are coerced to strings. " +
        "Recognised keys (used for dedicated DB columns and dashboard display): " +
        "leadFirstName, leadLastName, leadTitle, leadCompanyName, leadCompanyIndustry, clientCompanyName. " +
        "Keys must be flat — e.g. send { leadFirstName: \"Alice\" }, NOT { lead: { data: { firstName: \"Alice\" } } }."
      ),
      // Tracking / linking
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      apolloEnrichmentId: z.string().optional(),
      leadId: z.string().optional().describe("Lead-service correlation ID, unique per campaign"),
      idempotencyKey: z.string().optional(),
      workflowName: z.string().optional(),
      includeAiDisclaimer: z.boolean().optional().default(false).describe("When true, appends a small AI-generated disclaimer to the email body"),
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional(), "x-workflow-name": z.string().optional() }),
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
      description: "Prompt not found for this type",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Shared EmailGeneration schema (mirrors Drizzle emailGenerations table)
// ---------------------------------------------------------------------------
const EmailGenerationSchema = registry.register(
  "EmailGeneration",
  z
    .object({
      id: z.string().uuid(),
      orgId: z.string().uuid(),
      runId: z.string(),
      apolloEnrichmentId: z.string().nullable(),
      promptType: z.string().nullable(),

      // Lead info (populated from variables)
      leadFirstName: z.string().nullable(),
      leadLastName: z.string().nullable(),
      leadCompany: z.string().nullable(),
      leadTitle: z.string().nullable(),
      leadIndustry: z.string().nullable(),

      // Client info
      clientCompanyName: z.string().nullable(),
      clientCompanyDescription: z.string().nullable(),

      // Full variable data for audit
      variablesRaw: z.unknown().nullable(),

      // External references
      brandId: z.string(),
      campaignId: z.string(),
      generationRunId: z.string().nullable(),

      // Generated email sequence
      subject: z.string().nullable(),
      bodyHtml: z.string().nullable(),
      bodyText: z.string().nullable(),
      sequence: z.unknown().nullable(),

      // Model info
      model: z.string(),
      tokensInput: z.number().nullable(),
      tokensOutput: z.number().nullable(),

      // Raw data for debugging
      promptRaw: z.string().nullable(),
      responseRaw: z.unknown().nullable(),

      // Workflow tracking
      workflowName: z.string().nullable(),
      leadId: z.string().nullable(),
      idempotencyKey: z.string().nullable(),

      createdAt: z.string(),
    })
    .openapi("EmailGeneration")
);

// ---------------------------------------------------------------------------
// GET /generations?runId&campaignId&brandId
// ---------------------------------------------------------------------------
const GenerationsListResponseSchema = registry.register(
  "GenerationsListResponse",
  z
    .object({
      generations: z.array(EmailGenerationSchema),
    })
    .openapi("GenerationsListResponse")
);

registry.registerPath({
  method: "get",
  path: "/generations",
  tags: ["Content Generation"],
  summary: "List generations with filters",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional(), "x-workflow-name": z.string().optional() }),
    query: z.object({
      runId: z.string().optional(),
      campaignId: z.string().optional(),
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
      generation: EmailGenerationSchema,
    })
    .openapi("GenerationSingleResponse")
);

registry.registerPath({
  method: "get",
  path: "/generations/by-enrichment/{apolloEnrichmentId}",
  tags: ["Content Generation"],
  summary: "Get generation by enrichment ID",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional(), "x-workflow-name": z.string().optional() }),
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
// GET /generations/by-lead/:leadId
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/generations/by-lead/{leadId}",
  tags: ["Content Generation"],
  summary: "Get generation by lead-service correlation ID",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional(), "x-workflow-name": z.string().optional() }),
    params: z.object({ leadId: z.string() }),
  },
  responses: {
    200: {
      description: "Content generation for this lead",
      content: {
        "application/json": { schema: GenerationSingleResponseSchema },
      },
    },
    404: {
      description: "No generation found for this leadId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /stats — new standardised endpoint
// ---------------------------------------------------------------------------
export const StatsQuerySchema = registry.register(
  "StatsQuery",
  z
    .object({
      campaignId: z.string().optional(),
      brandId: z.string().optional(),
      orgId: z.string().optional(),
      runIds: z.string().optional().describe("Comma-separated list of run IDs"),
      groupBy: z.enum(["campaignId", "model"]).optional(),
    })
    .openapi("StatsQuery")
);

const StatsGroupSchema = z.object({
  key: z.string().nullable(),
  stats: z.object({ emailsGenerated: z.number() }),
});

const StatsGetFlatResponseSchema = registry.register(
  "StatsGetFlatResponse",
  z
    .object({
      stats: z.object({ emailsGenerated: z.number() }),
    })
    .openapi("StatsGetFlatResponse")
);

const StatsGetGroupedResponseSchema = registry.register(
  "StatsGetGroupedResponse",
  z
    .object({
      groups: z.array(StatsGroupSchema),
    })
    .openapi("StatsGetGroupedResponse")
);

registry.registerPath({
  method: "get",
  path: "/stats",
  tags: ["Stats"],
  summary: "Get aggregated stats with optional grouping",
  description:
    "Filters: campaignId, brandId, orgId, runIds (comma-separated). " +
    "Without groupBy returns { stats: { emailsGenerated } }. " +
    "With groupBy returns { groups: [{ key, stats: { emailsGenerated } }] }.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    query: StatsQuerySchema,
  },
  responses: {
    200: {
      description: "Stats (flat or grouped depending on groupBy param)",
      content: {
        "application/json": {
          schema: z.union([StatsGetFlatResponseSchema, StatsGetGroupedResponseSchema]),
        },
      },
    },
    400: {
      description: "Missing required filter",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /stats (deprecated — use GET /stats)
// ---------------------------------------------------------------------------
export const StatsRequestSchema = registry.register(
  "StatsRequest",
  z
    .object({
      runIds: z.array(z.string()).optional(),
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional(), "x-workflow-name": z.string().optional() }),
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
      orgId: z.string().optional(),
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
