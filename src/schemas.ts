import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { CHAT_MODELS } from "./lib/chat-models.js";

extendZodWithOpenApi(z);

// Shared `model` field — version-free alias; provider derived downstream.
// Optional: omitted → chat-service-client defaults to 'pro' (google), the
// historical behavior. Source of truth for the alias set is CHAT_MODELS.
const ModelField = z
  .enum(CHAT_MODELS)
  .optional()
  .describe(
    "LLM model to generate with (version-free alias). Provider is derived automatically: " +
      "anthropic → haiku | sonnet | opus; google → flash-lite | flash | flash-pro | pro; " +
      "vercel → deepseek-flash (DeepSeek V4 Flash, routed through the Vercel AI Gateway). " +
      "The vercel path is text-only, which this service never exceeds; note that JSON-mode " +
      "enforcement there is best-effort (fails loud rather than degrading). " +
      "Omit to use the default 'pro' (google) — unchanged from before this field existed."
  );

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
  z.string().optional().openapi({ param: { name: "X-Brand-Id", in: "header", required: false, description: "Comma-separated list of brand UUIDs (e.g. 'uuid1,uuid2,uuid3'). Single UUID for single-brand campaigns." } })
);

const WorkflowSlugHeader = registry.registerParameter(
  "WorkflowSlug",
  z.string().optional().openapi({ param: { name: "X-Workflow-Slug", in: "header", required: false, description: "Workflow slug injected by workflow-service" } })
);

const FeatureSlugHeader = registry.registerParameter(
  "FeatureSlug",
  z.string().optional().openapi({ param: { name: "X-Feature-Slug", in: "header", required: false, description: "Feature slug for tracking, propagated through the service chain" } })
);

// ---------------------------------------------------------------------------
// Error response
// ---------------------------------------------------------------------------
const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z.object({ error: z.string() }).openapi("ErrorResponse")
);

const InsufficientCreditsResponseSchema = registry.register(
  "InsufficientCreditsResponse",
  z
    .object({
      error: z.string(),
      balance_cents: z.number(),
      required_cents: z.number(),
    })
    .openapi("InsufficientCreditsResponse")
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
export const PromptVariableSchema = registry.register(
  "PromptVariable",
  z
    .object({
      name: z.string().describe("Variable name as referenced in the prompt body via {{name}}."),
      description: z.string().describe(
        "Free-form description of what the caller should put for this variable. " +
        "Caller decides the JSON shape — string, array, object, whatever fits the template. " +
        "Multibrand is the default, so brand-related variables typically receive arrays or objects, not scalars."
      ),
    })
    .openapi("PromptVariable")
);

export const CreatePromptRequestSchema = registry.register(
  "CreatePromptRequest",
  z
    .object({
      type: z.string().describe("Unique prompt identifier, e.g. 'cold-email' or 'welcome-email'"),
      prompt: z.string().describe("Prompt template text with {{variable}} placeholders. Must NOT contain company-specific data — only {{variables}}."),
      variables: z.array(PromptVariableSchema).describe(
        "Inputs the template expects. Each entry is { name, description }; the caller decides the JSON shape per name."
      ),
    })
    .openapi("CreatePromptRequest")
);

export const VersionPromptRequestSchema = registry.register(
  "VersionPromptRequest",
  z
    .object({
      sourceType: z.string().describe("The type of the prompt to create a new version from, e.g. 'cold-email'"),
      prompt: z.string().describe("New prompt template text with {{variable}} placeholders. Must NOT contain company-specific data — only {{variables}}."),
      variables: z.array(PromptVariableSchema).describe(
        "Inputs the template expects. Each entry is { name, description }; the caller decides the JSON shape per name."
      ),
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
      variables: z.array(PromptVariableSchema),
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
    "If the prompt and variables are identical to the existing sourceType, returns the existing prompt as-is (200). " +
    "If sourceType already exists but content differs, creates a new prompt with an auto-incremented type name (201). " +
    "E.g. sourceType 'cold-email' → creates 'cold-email-v2'. " +
    "sourceType 'cold-email-v5' → creates 'cold-email-v6'. " +
    "If sourceType does not exist, creates the prompt with that type directly (201). " +
    "The source prompt is never modified.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: VersionPromptRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Prompt unchanged — returned existing version as-is",
      content: { "application/json": { schema: PromptResponseSchema } },
    },
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
// Prompt assignments — per-feature prompt resolution + fork-and-reassign
// ---------------------------------------------------------------------------
export const PromptAssignmentResponseSchema = registry.register(
  "PromptAssignmentResponse",
  z
    .object({
      featureSlug: z.string(),
      promptType: z.string().describe("The resolved prompt type rendered for this feature."),
      prompt: z.string(),
      variables: z.array(PromptVariableSchema),
      isDefault: z.boolean().describe("true when the feature resolves to the platform default (no override)."),
    })
    .openapi("PromptAssignmentResponse")
);

export const PutPromptAssignmentRequestSchema = registry.register(
  "PutPromptAssignmentRequest",
  z
    .object({
      featureSlug: z.string().describe("Feature slug whose prompt is being reassigned."),
      prompt: z.string().describe(
        "Edited prompt template text with {{variable}} placeholders. The {{var}} tokens MUST exactly match the " +
        "currently-resolved source template's declared variable-name set — any drop/rename/addition is rejected (400). " +
        "Must NOT contain company-specific data — only {{variables}}."
      ),
      variables: z.array(PromptVariableSchema).describe(
        "Inputs the template expects. Each entry is { name, description }; the caller decides the JSON shape per name."
      ),
    })
    .openapi("PutPromptAssignmentRequest")
);

export const PutPromptAssignmentResponseSchema = registry.register(
  "PutPromptAssignmentResponse",
  z
    .object({
      featureSlug: z.string(),
      promptType: z.string().describe("The forked prompt type now assigned to this feature."),
      prompt: z.string(),
      variables: z.array(PromptVariableSchema),
    })
    .openapi("PutPromptAssignmentResponse")
);

// GET /prompt-assignments?featureSlug= — Read the currently-resolved prompt for a feature
registry.registerPath({
  method: "get",
  path: "/prompt-assignments",
  tags: ["Prompts"],
  summary: "Get the currently-resolved prompt for a feature",
  description:
    "Resolves the prompt rendered when generating for this feature: feature assignment ▸ platform default. " +
    "isDefault:true when no override exists (resolves to the platform default).",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string().optional() }),
    query: z.object({ featureSlug: z.string().describe("Feature slug to resolve the prompt for") }),
  },
  responses: {
    200: {
      description: "Resolved prompt for the feature",
      content: { "application/json": { schema: PromptAssignmentResponseSchema } },
    },
    400: {
      description: "Missing featureSlug query param",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Resolved prompt type not registered",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// PUT /prompt-assignments — Fork the resolved prompt + reassign the feature to the fork
registry.registerPath({
  method: "put",
  path: "/prompt-assignments",
  tags: ["Prompts"],
  summary: "Fork the resolved prompt and reassign the feature to the fork",
  description:
    "Forks the currently-resolved prompt type for the feature (auto-incremented '<type>-vN'), then assigns the feature " +
    "to the new fork. The source template is never modified. Returns 400 (naming the offending variable) if the {{var}} " +
    "tokens in the submitted prompt do not exactly match the source template's declared variable-name set — on 400 " +
    "nothing is forked or assigned.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string().optional() }),
    body: {
      required: true,
      content: { "application/json": { schema: PutPromptAssignmentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Feature reassigned to the forked prompt",
      content: { "application/json": { schema: PutPromptAssignmentResponseSchema } },
    },
    400: {
      description: "Invalid request, or submitted variables do not match the source template",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Resolved source prompt type not registered",
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
        "Any JSON values allowed — strings, arrays, or objects. Caller decides the shape per variable. " +
        "Objects and arrays are rendered as readable markdown into the prompt; the LLM reads whatever's provided. " +
        "Multibrand is the default in this platform, so brand-related variables typically receive arrays or objects, not scalars. " +
        "Per-template input expectations are published via GET /platform-prompts?type=<type> (.variables: Array<{ name, description }>). " +
        "When values are string-typed, recognised keys may also populate dedicated dashboard columns: " +
        "leadFirstName, leadLastName, leadTitle, leadCompanyName, leadCompanyIndustry, organizationDomain, clientCompanyName."
      ),
      model: ModelField,
      // Tracking / linking
      brandIds: z.array(z.string()).optional().describe("Brand UUIDs associated with this generation. Falls back to parsed x-brand-id header (CSV) if omitted."),
      campaignId: z.string().optional(),
      apolloEnrichmentId: z.string().optional(),
      leadId: z.string().optional().describe("Lead-service correlation ID, unique per campaign"),
      idempotencyKey: z.string().optional(),
      workflowSlug: z.string().optional(),
      featureSlug: z.string().optional().describe("Feature slug for tracking"),
      audienceId: z.string().optional().describe("Audience attribution ID. Falls back to x-audience-id header if omitted."),
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
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
    402: {
      description: "Insufficient credits (platform costSource only)",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    404: {
      description: "Prompt not found for this type",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /generate-expert-quote-pitch — Free-text pitch for journalist quote requests
// ---------------------------------------------------------------------------
export const GenerateExpertQuotePitchRequestSchema = registry.register(
  "GenerateExpertQuotePitchRequest",
  z
    .object({
      variables: z.record(z.string(), z.unknown()).describe(
        "Variable values to substitute into the stored 'expert-quote-pitch' template. ALL of the template's declared " +
        "variables are REQUIRED and must be non-empty (missing/empty → 400). For the platform template the required set is " +
        "three generic-JSON blobs: `expert` (the person whose quote gets published — name/title/bio/photo/linkedin/answer " +
        "context), `brands` (the brand(s) the expert represents — multibrand, usually an array), and `journalistRequest` " +
        "(the journalist's request). Inner JSON shape per variable is caller's choice; " +
        "the authoritative input list is published via GET /platform-prompts?type=expert-quote-pitch (.variables)."
      ),
      templateType: z.string().optional().describe(
        "Explicit prompt type to render, overriding feature assignment + platform default. " +
        "Resolution order: templateType ▸ feature assignment for featureSlug ▸ platform default 'expert-quote-pitch'."
      ),
      model: ModelField,
      brandIds: z.array(z.string()).optional().describe("Brand UUIDs for tracking. Falls back to x-brand-id header."),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional(),
      featureSlug: z.string().optional(),
      audienceId: z.string().optional().describe("Audience attribution ID. Falls back to x-audience-id header if omitted."),
    })
    .openapi("GenerateExpertQuotePitchRequest")
);

const GenerateExpertQuotePitchResponseSchema = registry.register(
  "GenerateExpertQuotePitchResponse",
  z
    .object({
      pitch: z.string().describe("Pitch text, 100-2500 chars"),
      charCount: z.number().int().describe("Length of pitch in characters"),
      attempts: z.number().int().describe("Number of generation attempts (1 or 2)"),
      tokensInput: z.number(),
      tokensOutput: z.number(),
    })
    .openapi("GenerateExpertQuotePitchResponse")
);

const ExpertQuotePitchLengthErrorResponseSchema = registry.register(
  "ExpertQuotePitchLengthErrorResponse",
  z
    .object({
      error: z.string(),
      charCount: z.number().int(),
      minChars: z.number().int(),
      maxChars: z.number().int(),
      attempts: z.number().int(),
    })
    .openapi("ExpertQuotePitchLengthErrorResponse")
);

registry.registerPath({
  method: "post",
  path: "/generate-expert-quote-pitch",
  tags: ["Content Generation"],
  summary: "Generate a journalist-quote pitch (Featured.com 100-2500 char constraint)",
  description:
    "Renders the stored 'expert-quote-pitch' prompt with brand + request inputs, sends to chat-service for free-text generation, " +
    "and enforces a 100-2500 character output range. If the first attempt is out of range, retries once with a corrective nudge. " +
    "Returns 400 ExpertQuotePitchLengthErrorResponse if both attempts are out of range — no truncation that breaks meaning.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional(), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
    body: {
      required: true,
      content: { "application/json": { schema: GenerateExpertQuotePitchRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Generated pitch within the configured char range",
      content: { "application/json": { schema: GenerateExpertQuotePitchResponseSchema } },
    },
    400: {
      description: "Invalid request body or pitch length out of range after retry",
      content: { "application/json": { schema: ExpertQuotePitchLengthErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description: "Insufficient credits",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    404: {
      description: "expert-quote-pitch template not registered",
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
      leadOrganizationDomain: z.string().nullable(),

      // Client info
      clientCompanyName: z.string().nullable(),
      clientCompanyDescription: z.string().nullable(),

      // Full variable data for audit
      variablesRaw: z.unknown().nullable(),

      // External references
      brandIds: z.array(z.string()).describe("Brand UUIDs associated with this generation (multi-brand support)"),
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
      workflowSlug: z.string().nullable(),
      featureSlug: z.string().nullable(),
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
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
// GET /generations/examples — Gold-layer cascade of example emails for a workflow
// ---------------------------------------------------------------------------
const ExampleEmailSchema = registry.register(
  "ExampleEmail",
  z
    .object({
      id: z.string().uuid(),
      subject: z.string().nullable(),
      bodyHtml: z.string().nullable(),
      bodyText: z.string().nullable(),
      sequence: z.unknown().describe("Per-step email sequence array (same shape as GET /generations)."),
      leadFirstName: z.string().nullable(),
      leadLastName: z.string().nullable(),
      leadCompany: z.string().nullable(),
      leadTitle: z.string().nullable(),
      leadIndustry: z.string().nullable(),
      clientCompanyName: z.string().nullable(),
      createdAt: z.string(),
      scope: z
        .enum(["brand", "org", "global"])
        .describe("Cascade tier this example came from, relative to the caller's brandId/orgId."),
      brandName: z
        .string()
        .nullable()
        .describe("Display name of the SOURCE brand (org/global tiers); null for own-brand scope or when unavailable."),
    })
    .openapi("ExampleEmail")
);

const GenerationsExamplesResponseSchema = registry.register(
  "GenerationsExamplesResponse",
  z
    .object({
      examples: z.array(ExampleEmailSchema),
    })
    .openapi("GenerationsExamplesResponse")
);

registry.registerPath({
  method: "get",
  path: "/generations/examples",
  tags: ["Content Generation"],
  summary: "Cascade example emails for a workflow (brand → org → global)",
  description:
    "Returns up to `limit` content-bearing example emails for a workflow, with a fallback cascade so it (almost) " +
    "always returns `limit`: (1) the caller's current brand, then (2) the caller's other brands, then (3) any org " +
    "(examples are public). Each example is tagged with `scope` (which tier it came from) and `brandName` (the source " +
    "brand's label for org/global tiers; null for own-brand). Brand-tier rows come first, newest-first within each tier. " +
    "Content-less / failed generations are skipped. Default limit 3.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string().optional() }),
    query: z.object({
      workflowSlug: z.string().describe("Workflow slug to fetch examples for"),
      brandId: z.string().describe("Caller's current brand UUID — anchors the brand/org cascade tiers"),
      limit: z.string().optional().describe("Max examples to return (default 3)"),
    }),
  },
  responses: {
    200: {
      description: "Up to `limit` example emails, brand-tier first",
      content: { "application/json": { schema: GenerationsExamplesResponseSchema } },
    },
    400: {
      description: "Missing workflowSlug or brandId",
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
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
      workflowSlug: z.string().optional().describe("Filter by exact workflow slug"),
      featureSlug: z.string().optional().describe("Filter by exact feature slug"),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug (resolved to all versioned slugs)"),
      featureDynastySlug: z.string().optional().describe("Filter by feature dynasty slug (resolved to all versioned slugs)"),
      groupBy: z.enum(["campaignId", "model", "workflowSlug", "featureSlug", "workflowDynastySlug", "featureDynastySlug"]).optional(),
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
    "Filters: campaignId, brandId, orgId, runIds (comma-separated), workflowSlug, featureSlug, workflowDynastySlug, featureDynastySlug. " +
    "Dynasty slug filters are resolved to versioned slug lists via workflow-service / features-service. " +
    "Without groupBy returns { stats: { emailsGenerated } }. " +
    "With groupBy returns { groups: [{ key, stats: { emailsGenerated } }] }. " +
    "groupBy=workflowDynastySlug/featureDynastySlug aggregates versioned slugs into their dynasty.",
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
// POST /compose — Compose a split-screen video (quote image + webcam)
// ---------------------------------------------------------------------------
export const ComposeRequestSchema = registry.register(
  "ComposeRequest",
  z
    .object({
      videoUrl: z.string().url().describe("Public URL of the webcam video (e.g. Vercel Blob)"),
      name: z.string().describe("First name of the person (displayed on the quote image)"),
      age: z.number().int().positive().describe("Age of the person"),
      theme: z.string().describe("Theme of the quote (e.g. 'Loss of Desire')"),
      text: z.string().describe("Quote text to display"),
      outputBlobToken: z.string().describe("Vercel Blob token for uploading the composed video"),
      layout: z.enum(["quote-top", "webcam-top"]).default("quote-top").optional().describe("Layout: 'quote-top' (default) = quote 40% top + webcam 60% bottom; 'webcam-top' = webcam 50% top + quote 50% bottom"),
    })
    .openapi("ComposeRequest")
);

const ComposeResponseSchema = registry.register(
  "ComposeResponse",
  z
    .object({
      composedVideoUrl: z.string().url().describe("Public URL of the composed MP4 video"),
    })
    .openapi("ComposeResponse")
);

registry.registerPath({
  method: "post",
  path: "/compose",
  tags: ["Video Composition"],
  summary: "Compose a split-screen vertical video (9:16) from a quote and webcam recording",
  description:
    "Downloads the source webcam video, generates a styled quote image, " +
    "and uses FFmpeg to compose a split-screen video at 1080x1920 30fps. " +
    "Layout 'quote-top' (default): quote top 40% + webcam bottom 60%. " +
    "Layout 'webcam-top': webcam top 50% + quote bottom 50%. " +
    "The result is uploaded to Vercel Blob.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ComposeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Video composed and uploaded successfully",
      content: { "application/json": { schema: ComposeResponseSchema } },
    },
    400: {
      description: "Invalid request or video download failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Composition failed",
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
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
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

// ---------------------------------------------------------------------------
// POST /submagic/process — Full Submagic processing pipeline
// ---------------------------------------------------------------------------
export const SubmagicProcessRequestSchema = registry.register(
  "SubmagicProcessRequest",
  z
    .object({
      composedVideoUrl: z.string().url().describe("Public URL of the composed video to process"),
      title: z.string().describe("Project title for Submagic"),
      templateName: z.string().describe("Submagic template name (e.g. 'Hormozi 2')"),
      language: z.string().describe("Language code (e.g. 'en')"),
      magicZooms: z.boolean().describe("Enable magic zooms"),
      magicBrolls: z.boolean().describe("Enable magic B-rolls"),
      magicBrollsPercentage: z.number().int().min(0).max(100).describe("B-roll percentage (0-100)"),
      removeBadTakes: z.boolean().describe("Remove bad takes"),
      removeSilencePace: z.string().describe("Silence removal pace (e.g. 'fast')"),
      cleanAudio: z.boolean().describe("Enable audio cleaning"),
      exportWidth: z.number().int().positive().describe("Export width in pixels"),
      exportHeight: z.number().int().positive().describe("Export height in pixels"),
      exportFps: z.number().int().positive().describe("Export frames per second"),
    })
    .openapi("SubmagicProcessRequest")
);

const SubmagicProcessResponseSchema = registry.register(
  "SubmagicProcessResponse",
  z
    .object({
      projectId: z.string().describe("Submagic project ID"),
      videoUrl: z.string().url().describe("Final processed video URL"),
      previewUrl: z.string().url().describe("Submagic preview URL"),
    })
    .openapi("SubmagicProcessResponse")
);

const SubmagicErrorResponseSchema = registry.register(
  "SubmagicErrorResponse",
  z
    .object({
      error: z.string(),
      reason: z.string(),
    })
    .openapi("SubmagicErrorResponse")
);

registry.registerPath({
  method: "post",
  path: "/submagic/process",
  tags: ["Video Processing"],
  summary: "Process a video through Submagic (captions, effects, export)",
  description:
    "Creates a Submagic project, polls until processing completes, triggers export, " +
    "and polls until the final video URL is available. This is a synchronous endpoint " +
    "that can take 5-8 minutes to complete.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
    body: {
      required: true,
      content: { "application/json": { schema: SubmagicProcessRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Video processed and exported successfully",
      content: { "application/json": { schema: SubmagicProcessResponseSchema } },
    },
    400: {
      description: "Invalid request body or missing identity headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Submagic processing failed or key resolution failed",
      content: { "application/json": { schema: SubmagicErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /internal/transfer-brand — Re-assign solo-brand rows to a new org
// ---------------------------------------------------------------------------
export const TransferBrandRequestSchema = registry.register(
  "TransferBrandRequest",
  z
    .object({
      sourceBrandId: z.string().uuid().describe("The brand UUID to transfer from the source org"),
      sourceOrgId: z.string().uuid().describe("Current owning org UUID"),
      targetOrgId: z.string().uuid().describe("Destination org UUID"),
      targetBrandId: z.string().uuid().optional().describe("Brand UUID in the target org to rewrite to (when target org already has this brand)"),
    })
    .openapi("TransferBrandRequest")
);

const TransferBrandResponseSchema = registry.register(
  "TransferBrandResponse",
  z
    .object({
      updatedTables: z.array(
        z.object({
          tableName: z.string(),
          count: z.number(),
        })
      ),
    })
    .openapi("TransferBrandResponse")
);

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  tags: ["Internal"],
  summary: "Transfer solo-brand rows from one org to another",
  description:
    "Finds all rows where org_id = sourceOrgId and brand_ids contains exactly one element equal to sourceBrandId, " +
    "then updates org_id to targetOrgId. When targetBrandId is provided, also rewrites brand_ids to the target brand. " +
    "Skips co-branding rows (multiple brand IDs). Idempotent.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer complete — returns count of updated rows per table",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
