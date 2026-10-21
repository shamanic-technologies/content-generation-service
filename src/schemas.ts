import { MAX_INSTRUCTION_LENGTH } from "./lib/campaign-instruction.js";
import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { CHAT_MODELS } from "./lib/chat-models.js";
import { CATALOGUE_STATUSES, MAX_STATUS_REASON_LENGTH, NOT_SPECIFIED, STAFF_EMAIL_HEADER } from "./lib/catalogue-status.js";
import { DEBRIEF_ERROR_CODES } from "./lib/debrief/errors.js";
import { DYNASTY_IDENTITIES } from "./lib/template-dynasties.js";

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
      "deepseek → deepseek-flash (DeepSeek V4 Flash) | deepseek-pro (DeepSeek V4 Pro); " +
      "zai → glm-flash (glm-4.7-flashx) | glm-pro (glm-5.2); " +
      "moonshot → kimi-flash (kimi-k2.6) | kimi-pro (kimi-k3). " +
      "The six deepseek/zai/moonshot aliases are called directly on each vendor's " +
      "OpenAI-compatible API. That path is text-only, which this service never exceeds; note " +
      "that JSON-mode enforcement there is best-effort (fails loud rather than degrading), and " +
      "a vendor whose account is out of credit answers 429 — surfaced as an error naming the " +
      "provider, never silently rerouted to another vendor. " +
      "Omit to use the default 'pro' (google) — unchanged from before this field existed. " +
      "Every alias stays accepted here whatever its staff status: a NEW workflow must not name one whose " +
      "status is `deprecated` on GET /internal/models, but a stored workflow that does keeps generating."
  );

// Staff catalogue status (src/lib/catalogue-status.ts). Read before the prompt schemas use it.
const CatalogueStatusField = z
  .enum(CATALOGUE_STATUSES)
  .describe(
    "Staff catalogue status. `active` (default) or `deprecated`: a NEW workflow must not name a deprecated " +
      "template or model (workflow-service refuses it at write time). Never read by POST /generate: a stored " +
      "workflow that names it keeps generating. Cross-org (no per-org or per-brand status)."
  );
const StatusChangedAtField = z
  .string()
  .nullable()
  .describe("When staff last changed the status (ISO 8601). Null = never changed (active since creation).");
// Why + who of a deprecation (DEPRECATION-REASON-1020). Spread into every read serving a status.
const StatusReasonFields = {
  statusReason: z
    .string()
    .nullable()
    .describe(
      `Why it is deprecated, in plain words, as staff wrote it. \`${NOT_SPECIFIED}\` = deprecated before a reason was required. Null when active.`
    ),
  statusChangedBy: z
    .string()
    .nullable()
    .describe("Staff email of who last changed the status. Null = unknown (never changed, or changed before this was recorded)."),
};

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

// Brand/offer neutrality of a shared template (src/lib/template-neutrality.ts).
const TemplateNotNeutralResponseSchema = registry.register(
  "TemplateNotNeutralResponse",
  z
    .object({
      error: z.string().openapi({ description: "What is wrong and how to fix it, written for the caller to act on." }),
      code: z.literal("TEMPLATE_NOT_NEUTRAL"),
      passages: z
        .array(
          z.object({
            passage: z.string().openapi({ description: "The refused passage, verbatim as submitted." }),
            location: z.string().openapi({
              description: "`prompt` for the template body, `variables.<name>` for a variable description.",
            }),
            probability: z.number().openapi({ description: "Jev's probability (0..1) that the passage is specific." }),
          })
        )
        .openapi({ description: "Every passage that names or describes one specific company, offer, figure or person." }),
    })
    .openapi("TemplateNotNeutralResponse")
);

const TemplateNeutralityCheckFailedResponseSchema = registry.register(
  "TemplateNeutralityCheckFailedResponse",
  z
    .object({ error: z.string(), code: z.literal("TEMPLATE_NEUTRALITY_CHECK_FAILED") })
    .openapi("TemplateNeutralityCheckFailedResponse")
);

/**
 * Responses shared by every route that STORES a template: each new template is
 * judged brand/offer neutral (chat-service Jev) before it is stored.
 */
const TEMPLATE_NEUTRALITY_RESPONSES = {
  402: {
    description: "The neutrality judgment could not be paid (chat-service 402). Nothing stored.",
    content: { "application/json": { schema: TemplateNeutralityCheckFailedResponseSchema } },
  },
  422: {
    description:
      "The template is not brand/offer neutral: a passage of its fixed text names a specific company, brand, offer, " +
      "price, figure or person. Templates are shared by every brand. Replace the specific part of each cited passage " +
      "with a {{variable}} declared in `variables`, or make it generic, then resubmit. Nothing stored.",
    content: { "application/json": { schema: TemplateNotNeutralResponseSchema } },
  },
  429: {
    description: "The judgment vendor rate-limited the check (retryable). Nothing stored.",
    content: { "application/json": { schema: TemplateNeutralityCheckFailedResponseSchema } },
  },
  502: {
    description: "The neutrality judgment failed upstream (chat-service). Nothing stored.",
    content: { "application/json": { schema: TemplateNeutralityCheckFailedResponseSchema } },
  },
} as const;

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
      variables: z.array(PromptVariableSchema).describe(
        "Inputs this template body declares via {{token}}. Unchanged contract: forks must match this set exactly."
      ),
      contextVariables: z.array(PromptVariableSchema).describe(
        "Optional lead and organization inputs EVERY template accepts, whether or not its body declares a {{token}} for them. " +
        "Send any subset on POST /generate: values not consumed by a {{token}} are rendered into a 'Recipient context' block ahead of the template. " +
        "Sending none of them leaves the prompt byte-identical to what it was before this field existed. " +
        "The same list is returned for every prompt type."
      ),
      status: CatalogueStatusField,
      statusChangedAt: StatusChangedAtField,
      ...StatusReasonFields,
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
  description:
    "A new template is judged brand/offer neutral before it is stored (422 with the cited passages otherwise). " +
    "Templates are shared by every brand, so fixed text must not name one company, offer, figure or person.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreatePromptRequestSchema } },
    },
  },
  responses: {
    ...TEMPLATE_NEUTRALITY_RESPONSES,
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
  description:
    "Used at cold start to register prompt templates. Same pattern as key-service POST /platform-keys. " +
    "A new template is judged brand/offer neutral before it is stored (422 with the cited passages otherwise).",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreatePromptRequestSchema } },
    },
  },
  responses: {
    ...TEMPLATE_NEUTRALITY_RESPONSES,
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
    "The source prompt is never modified. " +
    "A new version is judged brand/offer neutral before it is stored (422 with the cited passages otherwise).",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: VersionPromptRequestSchema } },
    },
  },
  responses: {
    ...TEMPLATE_NEUTRALITY_RESPONSES,
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
      status: CatalogueStatusField,
      statusChangedAt: StatusChangedAtField,
      ...StatusReasonFields,
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
    "nothing is forked or assigned. The fork is judged brand/offer neutral before it is stored (422 with the cited " +
    "passages otherwise, nothing forked or assigned).",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string().optional() }),
    body: {
      required: true,
      content: { "application/json": { schema: PutPromptAssignmentRequestSchema } },
    },
  },
  responses: {
    ...TEMPLATE_NEUTRALITY_RESPONSES,
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
        "Per-template input expectations are published via GET /platform-prompts?type=<type> (.variables: Array<{ name, description }>), " +
        "alongside .contextVariables: optional lead and organization inputs every template accepts (person, employment history, organization industries, funding, location, and more). " +
        "One of them, leadRelationship, says who the recipient already is to the brand (relationship, thread, strategy): it is rendered as its own section and its strategy wins over a template written as a first contact. " +
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
      instruction: z.string().max(MAX_INSTRUCTION_LENGTH).nullable().optional().describe("The campaign's own instruction (campaign-service's sales-funnel campaign `instruction`, reported by /start-run; workflow-service threads it into every /generate body). When set, the email is written from it: it outranks the template's angle, pitch and structure, never the output format. Absent, null or blank = the template alone, byte-identical to before."),
      offerId: z.string().optional().describe("The campaign's offer id. Forwarded to brand-service on the extract-fields request, which refuses brand-scoped reads for a brand selling several offers until one is named. Body only — there is no header fallback. Sent only when a single brand is named; ignored for a multi-brand request, which brand-service rejects with an offer."),
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
// POST /preview-email — ONE cold email for a brand + a sample recipient, no campaign/lead
// ---------------------------------------------------------------------------
const PreviewRecipientSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    title: z.string().trim().min(1).describe("The recipient's job title."),
    companyName: z.string().trim().min(1),
    companyDomain: z.string().trim().min(1).optional().describe("The recipient's company website or domain."),
    headline: z.string().trim().min(1).optional().describe("The recipient's own one-line professional headline."),
    companyIndustry: z.string().trim().min(1).optional(),
    companyDescription: z.string().trim().min(1).optional(),
  })
  .openapi("PreviewRecipient");

const PreviewQualificationCheckSchema = z
  .object({
    question: z.string().describe("The check's question, as the offer states it."),
    mode: z.string().optional().describe("must_pass (Hard filter) or mention (Bonus)."),
    verdict: z.string().optional().describe("yes | no | unavailable | not_checked"),
    evidence: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    screenshotUrl: z.string().nullable().optional(),
  })
  .passthrough();

const PreviewQualificationSchema = z
  .object({
    domain: z.string().nullable().optional().describe("The company the checks ran on."),
    checks: z.array(PreviewQualificationCheckSchema),
  })
  .passthrough()
  .openapi("PreviewQualification");

export const PreviewEmailRequestSchema = registry.register(
  "PreviewEmailRequest",
  z
    .object({
      brandId: z.string().uuid().describe("A brand of the calling org. Its site must already be readable by brand-service."),
      recipient: PreviewRecipientSchema,
      audience: z.string().trim().min(1).optional().describe("The audience / segment the sample recipient was found in, in plain English. Given to the model as context."),
      offerId: z.string().uuid().optional().describe("Which offer of the brand to pitch. Required by brand-service only when the brand sells several offers."),
      qualification: PreviewQualificationSchema.optional().describe(
        "The offer's checks run on the recipient's company, exactly as lead-service serves them for that company (the same shape as a lead's `qualification`): { domain, checks: [{ question, mode ('must_pass' | 'mention'), verdict ('yes' | 'no' | 'unavailable' | 'not_checked'), evidence, reason, screenshotUrl, ... }] }. Forward it verbatim. Rendered to the model in the same \"Checks we ran on their company\" block as a campaign email (context only). Part of the stored preview's identity: changed results write a new email, the same results are answered from storage. Absent or `checks: []` = the preview is written exactly as without it."
      ),
      strategyId: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Write the example the way a campaign running this play of the cold-email pipe would: a features-service strategy id on `sales-cold-email-outreach|lead_found_to_conversation` " +
            "(`offer-emails-only` = leads with something given for free, `named-emails-only` = names the brand and pitches it, `blind-emails-only` = never names the brand, asks about the problem first; any other play of the pipe works too). " +
            "The email is written with the template + model of the workflow that play's campaign would run (its measured best, else the first workflow it allows in the leg ranking). " +
            "Absent = the best mature cold-email workflow, as before. A strategy with no play on the pipe = 400 `code: UNKNOWN_STRATEGY`."
        ),
    })
    .openapi("PreviewEmailRequest")
);

const PreviewHighlightSchema = z
  .object({
    text: z.string().describe("A sentence or clause of bodyText, verbatim."),
    start: z.number().int().describe("Offset of text in bodyText (JS string index): bodyText.slice(start, end) === text."),
    end: z.number().int(),
    kind: z
      .enum(["prospect", "brand", "audience", "instruction"])
      .describe(
        "Where the reason comes from. prospect: a fact about the recipient or their company (the data sent in `recipient`). " +
          "brand: a fact about the sender's company, read from its website by brand-service. audience: the segment sent in `audience`. " +
          "instruction: a writing rule of the email template (greeting, diagnostic question, call to action), not a fact."
      ),
    source: z
      .string()
      .describe("The exact input: `recipient.<field>`, `check.<n>` (the n-th check of `qualification`), `audience`, `brand.name`, `brand.<extracted field key>` (e.g. brand.customerPainPoints), or `instruction`."),
    sourceLabel: z.string().describe("Plain-English name of that input."),
    sourceValue: z.string().nullable().describe("The input's actual value as the model received it. null for instruction."),
    reason: z.string().describe("Why this text is there, in one sentence, as reported by the model that wrote the email."),
  })
  .openapi("PreviewHighlight");

const PreviewEmailResponseSchema = registry.register(
  "PreviewEmailResponse",
  z
    .object({
      id: z.string().uuid().describe("Stored preview id."),
      brandId: z.string(),
      brandName: z.string(),
      recipient: PreviewRecipientSchema,
      subject: z.string(),
      bodyText: z.string().describe("The first email of the sequence the product would send, as plain text."),
      bodyHtml: z.string(),
      model: z.string().describe("Resolved model id that wrote the email."),
      promptType: z.string().describe("The prompt template that wrote the email: the best mature cold-email workflow's, when it was written."),
      modelAlias: z.string().nullable().describe("The model alias the workflow states (e.g. glm-pro). null on a preview stored before the preview followed the best mature workflow."),
      workflowSlug: z
        .string()
        .nullable()
        .describe("The workflow whose template + model wrote the email (the best mature cold-email workflow at the time). null on a preview stored before the preview followed it."),
      highlights: z
        .array(PreviewHighlightSchema)
        .nullable()
        .describe(
          "Why each sentence of bodyText exists and which input it rests on, in body order, non-overlapping. Reported by a SECOND " +
            "completion that reads the finished email (the writing call is the plain /generate call), then checked here: every text is " +
            "verbatim in bodyText and every source is an input actually sent; anything failing a check is dropped, so a sentence may " +
            "carry no highlight. null when that second call failed (the email is served anyway) or for a preview stored before highlights existed."
        ),
      cached: z.boolean().describe("true when this brand + recipient was already written and the stored email is returned (nothing billed)."),
      createdAt: z.string(),
    })
    .openapi("PreviewEmailResponse")
);

registry.registerPath({
  method: "post",
  path: "/preview-email",
  tags: ["Content Generation"],
  summary: "Write ONE cold email for a brand and a sample recipient, before any campaign exists",
  description:
    "Writes the email the visitor would receive once they pay: the prompt template AND model of the fleet's best MATURE " +
    "cold-email workflow (features-service leg ranking, read at request time, cached a few minutes), with that workflow's " +
    "own brand intel request and input mapping. 502/503 when the ranking or the workflow cannot be read: there is no " +
    "fallback template or model. A request carrying `model` is refused (400). The LLM spend is declared and " +
    "authorized against the calling org by chat-service; an org that cannot afford it gets 402. Creates no campaign, no lead " +
    "and no email_generations row, so nothing here can be sent or counted. The same brand + recipient (+ audience, offer, model) " +
    "returns the stored email instead of a second billed completion, as long as the best workflow is unchanged.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: PreviewEmailRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The written email",
      content: { "application/json": { schema: PreviewEmailResponseSchema } },
    },
    400: {
      description: "Invalid request, or brand-service refused the brand (e.g. it has no readable site)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description: "The calling org cannot afford the completion",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    404: {
      description: "Brand not found for this org, or the offer is not one of the brand's",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "The brand sells several offers; name one with offerId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "brand-service or the model failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

export const PreviewEmailPrepareRequestSchema = registry.register(
  "PreviewEmailPrepareRequest",
  z
    .object({
      brandId: z.string().uuid().describe("A brand of the calling org, the one the previews will be written for."),
      offerId: z
        .string()
        .uuid()
        .optional()
        .describe("Optional. Only needed when the brand already sells several offers; the warmed brand intel is shared by every offer of the brand."),
    })
    .openapi("PreviewEmailPrepareRequest")
);

const PreviewEmailPrepareResponseSchema = registry.register(
  "PreviewEmailPrepareResponse",
  z
    .object({
      brandId: z.string().uuid(),
      status: z
        .enum(["started", "in_progress", "ready"])
        .describe(
          "started: a warm-up began with this call. in_progress: one was already running for this brand; nothing new was started. " +
            "ready: one completed in the last few minutes; nothing was called. A warm-up that fails is logged and not reported here: " +
            "the preview then makes the read itself and returns brand-service's verdict."
        ),
    })
    .openapi("PreviewEmailPrepareResponse")
);

registry.registerPath({
  method: "post",
  path: "/preview-email/prepare",
  tags: ["Content Generation"],
  summary: "Get ready to write preview emails for a brand (fire and forget)",
  description:
    "Sends brand-service, in the background, the same brand-intel request POST /preview-email will send for this brand (the best " +
    "mature workflow's own field set), so the first preview finds it cached and only pays for the model. Answers 202 at once and never " +
    "waits for the site read (which can take minutes). Idempotent: at most one warm-up per org + brand runs at a time, a repeat " +
    "while it runs or shortly after it completes starts nothing, and brand-service's field cache makes any later repeat a cache read. " +
    "A POST /preview-email arriving while a warm-up runs waits for it rather than reading the site a second time. " +
    "Billing: the only spend is that brand-service read, the preview's own spend moved earlier, billed by brand-service to the calling " +
    "org (x-org-id). No email is written and no completion is made here.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: PreviewEmailPrepareRequestSchema } },
    },
  },
  responses: {
    202: {
      description: "Warm-up started, already running, or recently completed",
      content: { "application/json": { schema: PreviewEmailPrepareResponseSchema } },
    },
    400: {
      description: "Invalid request or missing identity headers",
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
      bodyHtml: z
        .string()
        .nullable()
        .describe(
          "The email body as HTML. Resolved at read time: rows written since sequences shipped store their copy in `sequence`, and this serves it. null only when the generation carries no copy at all (`bodySource: \"none\"`)."
        ),
      bodyText: z
        .string()
        .nullable()
        .describe(
          "The email body as plain text — the words actually written to this person. Resolved at read time from `sequence` when the legacy top-level column is empty. null only when the generation carries no copy at all."
        ),
      bodySource: z
        .enum(["column", "sequence", "none"])
        .describe(
          "Where bodyText/bodyHtml came from: `column` (legacy stored columns), `sequence` (first step of the stored sequence), or `none` — the generation genuinely has no readable copy. Lets a consumer tell missing copy apart from copy it can read."
        ),
      sequence: z.unknown().nullable().describe("The full planned cadence, every step, unchanged."),

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
  description:
    "A generation row carries the full prompt and raw model response, so a whole brand's history is far too " +
    "large to return at once. Pass `limit` (max 2000) and `offset` to page. Without `limit`, a result set over " +
    "2000 rows is refused with 413 rather than trimmed, so a partial list can never be mistaken for the whole one.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string(), "x-campaign-id": z.string().optional(), "x-brand-id": z.string().optional().describe("Comma-separated brand UUIDs (e.g. 'uuid1,uuid2')"), "x-workflow-slug": z.string().optional(), "x-feature-slug": z.string().optional() }),
    query: z.object({
      runId: z.string().optional(),
      campaignId: z.string().optional(),
      brandId: z.string().optional(),
      limit: z.string().optional().describe("Page size, 1..2000. Omit to read the whole result set (refused with 413 above 2000 rows)."),
      offset: z.string().optional().describe("Rows to skip, newest first. Defaults to 0."),
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
      description: "At least one filter required, or limit/offset out of range",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    413: {
      description: "Result set exceeds 2000 generations — page it with limit and offset",
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
      bodyHtml: z.string().nullable().describe("Example body as HTML, resolved from the sequence when the legacy column is empty."),
      bodyText: z.string().nullable().describe("Example body as plain text, resolved from the sequence when the legacy column is empty."),
      bodySource: z
        .enum(["column", "sequence", "none"])
        .describe("Where bodyText/bodyHtml came from: `column`, `sequence`, or `none` (no readable copy)."),
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
    query: z.object({
      brandId: z.string().optional().describe("Scope the read to one brand — a lead contacted by several brands of one org has one generation per brand"),
      campaignId: z.string().optional().describe("Scope the read to one campaign — a lead contacted by several campaigns of one brand has one generation per campaign, and this returns that campaign's. Omit it and no campaign is inferred. The campaign a returned generation belongs to is always on the row as campaignId."),
    }),
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
  summary: "Transfer a brand's rows from one org to another",
  description:
    "Moves, in one transaction, every email_generations row of the brand from sourceOrgId to targetOrgId: " +
    "solo-brand rows (brand_ids = [sourceBrandId]) and rows with no brand tag that belong to a campaign of the brand. " +
    "When targetBrandId is provided, rewrites brand_ids to it (only on rows in targetOrgId). " +
    "Co-branded rows (several brand ids) are left in place. Idempotent: a re-run reports 0.",
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

// ---------------------------------------------------------------------------
// GET /internal/sequences — fleet-wide sequence feed (src/lib/sequence-feed-query.ts)
// ---------------------------------------------------------------------------
export const SEQUENCE_FEED_MAX_LIMIT = 1000;

export const SequenceFeedQuerySchema = z
  .object({
    featureSlug: z
      .string()
      .min(1)
      .describe("The feature whose sequences to read, e.g. `sales-cold-email-outreach` (cold email channel)."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Opaque cursor returned as `nextCursor` by the previous page. Omit to start at the first sequence ever written."
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SEQUENCE_FEED_MAX_LIMIT)
      .optional()
      .describe(`Page size, 1..${SEQUENCE_FEED_MAX_LIMIT}. Omitted = 500.`),
  })
  .openapi("SequenceFeedQuery");

const FirstEmailShapeSchema = z
  .object({
    layout: z
      .enum(["one_block", "single_line_breaks", "double_line_breaks"])
      .describe(
        "How the first email's text is laid out: `double_line_breaks` = at least one blank line (paragraphs); " +
          "`single_line_breaks` = line breaks but no blank line; `one_block` = no line break at all."
      ),
    opening: z
      .enum(["greeting", "first_name_alone", "no_greeting"])
      .describe(
        "How the first email opens: `greeting` = a greeting word in any language we write in (Hi, Hello, Bonjour, Hallo, Hola, Ciao, Hej, ...), " +
          "whatever follows it; `first_name_alone` = the recipient's first name (or a single capitalised name-like word) glued " +
          "to the first sentence by a comma, colon, \"!\" or dash (\"Marie, I saw...\"); `no_greeting` = neither."
      ),
    dash: z
      .enum(["em", "en", "both", "none"])
      .describe(
        "Which dashes the first email carries: em dash (U+2014), en dash (U+2013), both, or none. A plain hyphen is not a dash. " +
          "HTML entities (&mdash; &ndash;) count as the dash they render."
      ),
  })
  .describe(
    "Deterministic classes of the FIRST email's stored text (no model involved). The stored text is the sent text. " +
      "`null` when the generation carries no copy."
  );

const SequenceFeedEntrySchema = z.object({
  generationId: z.string().uuid().describe("This service's generation id (one per sequence)."),
  orgId: z.string().describe("Internal org UUID the sequence was written for."),
  campaignId: z.string().describe("Platform campaign id. Unique with leadId: one sequence per campaign x lead."),
  leadId: z.string().describe("lead-service lead id of the recipient."),
  model: z
    .string()
    .describe(
      "The CONCRETE model id that wrote the sequence, as resolved at generation time (e.g. `gemini-3.1-pro-preview`, `claude-sonnet-5-5`), " +
        "never the workflow's alias."
    ),
  promptType: z
    .string()
    .nullable()
    .describe(
      "The template that wrote it: the prompt `type`, version included (e.g. `cold-email-v41`). Its text: GET /platform-prompts?type=<promptType>."
    ),
  workflowSlug: z.string().nullable().describe("The workflow VERSION slug whose run asked for the sequence. Null on rows written without one."),
  createdAt: z.string().describe("When the sequence was written (ISO 8601)."),
  runId: z.string().describe("The caller's run (the workflow run) that asked for the sequence."),
  generationRunId: z.string().nullable().describe("This service's own runs-service run for the generation (child of runId)."),
  firstEmail: FirstEmailShapeSchema.nullable(),
});

const SequenceFeedResponseSchema = registry.register(
  "SequenceFeedResponse",
  z
    .object({
      sequences: z.array(SequenceFeedEntrySchema).describe("Oldest first, in write order."),
      nextCursor: z
        .string()
        .nullable()
        .describe(
          "Pass as `cursor` on the next call. Always set once anything was ever served; equals the input cursor when nothing new arrived. " +
            "Null only when the feature has no sequence at all yet."
        ),
      hasMore: z.boolean().describe("true = another page is ready now; false = caught up (poll again later with nextCursor)."),
    })
    .openapi("SequenceFeedResponse")
);

registry.registerPath({
  method: "get",
  path: "/internal/sequences",
  tags: ["Internal"],
  summary: "Fleet-wide feed of generated sequences: what wrote each one and how its first email reads",
  description:
    "One entry per sequence this service generated for the feature (campaign x lead, every org, since inception), oldest first, " +
    "keyset-paged with an opaque cursor so a consumer follows it incrementally (resume from the last nextCursor, read only what is new). " +
    "Staff/service read: API key only, no identity headers. Generations without a lead id are not served. " +
    "A sequence becomes visible ~60 s after it is written (keeps the cursor from skipping a row still committing).",
  request: { query: SequenceFeedQuerySchema },
  responses: {
    200: {
      description: "A page of sequences",
      content: { "application/json": { schema: SequenceFeedResponseSchema } },
    },
    400: {
      description: "Missing featureSlug, bad limit, or a cursor this service did not issue",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── Industry debrief video (src/lib/debrief/) ──────────────────────────────

const DebriefPostSchema = z
  .discriminatedUnion("platform", [
    z.object({
      platform: z.literal("linkedin"),
      activityId: z.string().regex(/^\d{10,25}$/).describe("LinkedIn activity id: the digits of `urn:li:activity:<id>` / `activity-<id>` in the post URL."),
    }),
    z.object({
      platform: z.literal("x"),
      tweetId: z.string().regex(/^\d{5,25}$/).describe("The status id in https://x.com/<user>/status/<id>."),
    }),
  ])
  .describe("The original post shown on screen, captured from its PUBLIC embed (no login).");

export const DebriefStorySchema = z
  .object({
    post: DebriefPostSchema,
    spotlight: z
      .array(z.string().trim().min(3))
      .min(1)
      .max(2)
      .describe(
        "The sentence(s) to spotlight, VERBATIM from the post (straight vs curly apostrophes are matched either way). " +
          "One per story; two only if both are essential. On an X post, one short line. Not verbatim → the render fails SPOTLIGHT_NOT_FOUND."
      ),
    cropFrom: z
      .string()
      .min(1)
      .optional()
      .describe("Optional: start the card at this verbatim phrase, hiding everything above it (e.g. a figure we never show)."),
    kicker: z.string().trim().min(1).max(40).describe("Short label above the headline, usually the company in the news (`SalesCaptain`). Also used on the badge."),
    headline: z.string().trim().min(1).max(140).describe("The news in one line."),
    poster: z.object({
      relation: z
        .enum(["official", "own", "third"])
        .describe("official: the poster speaks for the company in the news. own: the news IS the poster's own test/experience. third: comments on someone else's news."),
      name: z.string().trim().min(1).optional().describe("Overrides the name read from the embed (when the embed shows a noisy display name)."),
      role: z.string().trim().min(1).max(60).describe("Short role, e.g. `CEO, SalesCaptain`."),
      about: z.string().trim().min(1).max(120).describe("What the poster's company does, one line, from their own headline or post."),
    }),
    why: z.string().trim().min(1).max(140).describe("Why it matters: one market observation, max ~15 words."),
    note: z.string().trim().min(1).max(160).describe("The note shown under `why` once it is read (attribution, sample size)."),
    take: z.string().trim().min(1).max(140).describe("What we think: our conviction, optimistic, max ~14 words, no figures."),
  })
  .openapi("DebriefStory");
export type DebriefStory = z.infer<typeof DebriefStorySchema>;

export const DebriefVideoRequestSchema = registry.register(
  "DebriefVideoRequest",
  z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The bulletin's day (YYYY-MM-DD), shown in the masthead as `Sunday, Oct 12`."),
      scan: z.object({
        postsRead: z.number().int().positive().describe("How many posts the day's scan read (the intro counts up to it)."),
        windowHours: z.number().int().positive().max(168).describe("How far back the scan read, in hours (`from the last 36 hours`)."),
      }),
      stories: z
        .array(DebriefStorySchema)
        .min(2)
        .max(4)
        .describe("The day's stories in screen order (2 to 4; our own news, when there is one, is a story like the others, last)."),
      idempotencyKey: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Same key + same org → the existing render is returned (no second render). Use e.g. `industry-debrief-<date>`."),
    })
    .openapi("DebriefVideoRequest")
);
export type DebriefVideoRequest = z.infer<typeof DebriefVideoRequestSchema>;

export const DebriefVideoSchema = registry.register(
  "DebriefVideo",
  z
    .object({
      id: z.string().uuid(),
      status: z.enum(["queued", "rendering", "done", "failed"]),
      stage: z.enum(["capturing", "rendering", "mixing", "checking", "uploading"]).nullable().describe("What a `rendering` job is doing now."),
      videoUrl: z.string().url().nullable().describe("Public MP4 URL (R2) once `done`: 1080x1350 (4:5), H.264 yuv420p, AAC, faststart."),
      durationSeconds: z.number().nullable().describe("The video's length = the scene's sum of screen times."),
      musicTrackId: z.number().int().nullable().describe("Mixkit track id used (rotates, never the previous render's)."),
      errorCode: z.enum(DEBRIEF_ERROR_CODES).nullable().describe("Why a `failed` job failed. Nothing is uploaded on failure."),
      error: z.string().nullable().describe("Human-readable failure detail, naming the story and phrase when relevant."),
      runId: z.string().nullable().describe("This render's runs-service run."),
      createdAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .openapi("DebriefVideo")
);

registry.registerPath({
  method: "post",
  path: "/industry-debrief-videos",
  tags: ["Industry debrief video"],
  summary: "Start rendering the daily industry debrief news-bulletin video (async)",
  description:
    "Queues a render of the 4:5 news bulletin defined by the industry-debrief-video skill: per story the headline, the real post " +
    "captured from its public embed with the sentence spotlit under a header saying who wrote it, why it matters + its note, " +
    "what we think; reading time per screen from word count; house chrome; sign-off; music longer than the video (rotating Mixkit " +
    "tracks, never looped). Answers 202 at once: a render takes several minutes, poll `GET /industry-debrief-videos/{id}?waitSeconds=240`. " +
    "Renders run one at a time on the service's own CPU (no metered vendor); the R2 upload is declared by cloudflare-service on this run.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string(), "x-run-id": z.string() }),
    body: { required: true, content: { "application/json": { schema: DebriefVideoRequestSchema } } },
  },
  responses: {
    202: { description: "Queued (or the existing render for this idempotencyKey)", content: { "application/json": { schema: DebriefVideoSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/industry-debrief-videos/{id}",
  tags: ["Industry debrief video"],
  summary: "A debrief render's status; optionally wait for it to finish",
  description:
    "With `waitSeconds` (1-240) the call holds until the render is `done`/`failed` or the wait elapses, then answers the current " +
    "state (always 200): one call stays under the platform's 300 s client timeout. A workflow polls it with " +
    "`validateResponse: { field: \"status\", equals: \"done\" }` and retries.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string() }),
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ waitSeconds: z.string().optional() }),
  },
  responses: {
    200: { description: "The render", content: { "application/json": { schema: DebriefVideoSchema } } },
    404: { description: "No render with this id for this org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── Staff catalogue status: templates + writer models (TEMPLATE-MODEL-STATUS-1019) ──

export const SetCatalogueStatusRequestSchema = registry.register(
  "SetCatalogueStatusRequest",
  z
    .object({
      status: CatalogueStatusField,
      reason: z
        .string()
        .max(MAX_STATUS_REASON_LENGTH)
        .optional()
        .describe(
          "REQUIRED when `status` is `deprecated`: why, in plain words (served back as `statusReason`). " +
            "Missing or blank → 400 `DEPRECATION_REASON_REQUIRED`. Ignored and cleared when re-activating."
        ),
    })
    .openapi("SetCatalogueStatusRequest")
);

const ModelStatusEntrySchema = registry.register(
  "ModelStatusEntry",
  z
    .object({
      model: z.enum(CHAT_MODELS).describe("Writer model alias, as accepted in `model` on POST /generate."),
      provider: z.string().describe("Provider the alias is served by (derived, never sent by a caller)."),
      status: CatalogueStatusField,
      statusChangedAt: StatusChangedAtField,
      ...StatusReasonFields,
    })
    .openapi("ModelStatusEntry")
);

const ModelStatusListResponseSchema = registry.register(
  "ModelStatusListResponse",
  z
    .object({
      models: z
        .array(ModelStatusEntrySchema)
        .describe("Every alias POST /generate accepts, each with its status. Only `active` ones may be named by a NEW workflow."),
    })
    .openapi("ModelStatusListResponse")
);

const TemplateStatusEntrySchema = registry.register(
  "TemplateStatusEntry",
  z
    .object({
      type: z.string().describe("Template type, version included (e.g. `cold-email-v59`)."),
      status: CatalogueStatusField,
      statusChangedAt: StatusChangedAtField,
      ...StatusReasonFields,
    })
    .openapi("TemplateStatusEntry")
);

const TemplateStatusListResponseSchema = registry.register(
  "TemplateStatusListResponse",
  z
    .object({ templates: z.array(TemplateStatusEntrySchema).describe("Every stored template, by type (A to Z). Bodies: GET /platform-prompts?type=.") })
    .openapi("TemplateStatusListResponse")
);

export const TemplateOutputsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).optional().describe("How many outputs, 1..20. Omitted = 5."),
  })
  .openapi("TemplateOutputsQuery");

const TemplateOutputSchema = z.object({
  generationId: z.string().uuid().describe("This service's generation id."),
  createdAt: z.string().describe("When it was written (ISO 8601)."),
  workflowSlug: z.string().nullable().describe("The workflow VERSION slug whose run asked for it. Null when written without one."),
  model: z.string().describe("The concrete model id that wrote it (e.g. `gemini-3.1-pro-preview`)."),
  subject: z.string().nullable().describe("Subject line of the sequence."),
  emails: z
    .array(
      z.object({
        step: z.number().int().describe("1 = the first email, then each follow-up."),
        bodyText: z.string().describe("The email's text as stored (= as sent)."),
        daysSinceLastStep: z.number().nullable().describe("Days after the previous email. Null when the stored step carries none."),
      })
    )
    .describe("Each email of the sequence, in order. Empty when the generation stored no copy."),
});

const TemplateOutputsResponseSchema = registry.register(
  "TemplateOutputsResponse",
  z
    .object({
      type: z.string(),
      outputs: z.array(TemplateOutputSchema).describe("Newest first, every org."),
    })
    .openapi("TemplateOutputsResponse")
);

const staffNote = "Staff/service route: API key only, no identity headers. Cross-org catalogue object.";
const staffEmailHeader = z.object({
  [STAFF_EMAIL_HEADER]: z
    .string()
    .optional()
    .describe(
      "Staff email of who changes the status, set by the staff gateway from the identity it verified. " +
        "REQUIRED to deprecate (400 `DEPRECATED_BY_REQUIRED`); recorded when present on a re-activation."
    ),
});

registry.registerPath({
  method: "get",
  path: "/internal/models",
  tags: ["Internal"],
  summary: "Every writer model alias with its staff status",
  description: `${staffNote} workflow-service reads it at workflow write time and refuses a deprecated model.`,
  responses: {
    200: { description: "All aliases", content: { "application/json": { schema: ModelStatusListResponseSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/internal/models/{model}/status",
  tags: ["Internal"],
  summary: "Set a writer model's staff status (active or deprecated)",
  description: `${staffNote} Changes the status only; POST /generate keeps accepting the alias.`,
  request: {
    params: z.object({ model: z.string().describe("Model alias, e.g. `glm-pro`") }),
    headers: staffEmailHeader,
    body: { content: { "application/json": { schema: SetCatalogueStatusRequestSchema } } },
  },
  responses: {
    200: { description: "Status set", content: { "application/json": { schema: ModelStatusEntrySchema } } },
    400: { description: "Missing or unknown status, or a deprecation without a reason (`DEPRECATION_REASON_REQUIRED`) or without who (`DEPRECATED_BY_REQUIRED`)", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not an alias this service accepts", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/templates",
  tags: ["Internal"],
  summary: "Every stored template type with its staff status",
  description: `${staffNote} The same status is on GET /prompts and GET /platform-prompts.`,
  responses: {
    200: { description: "All templates", content: { "application/json": { schema: TemplateStatusListResponseSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/internal/templates/{type}/status",
  tags: ["Internal"],
  summary: "Set a template's staff status (active or deprecated)",
  description: `${staffNote} Changes the status only: the template text, variables and updatedAt are untouched, and POST /generate keeps rendering it.`,
  request: {
    params: z.object({ type: z.string().describe("Template type, e.g. `cold-email-v59`") }),
    headers: staffEmailHeader,
    body: { content: { "application/json": { schema: SetCatalogueStatusRequestSchema } } },
  },
  responses: {
    200: { description: "Status set", content: { "application/json": { schema: TemplateStatusEntrySchema } } },
    400: { description: "Missing or unknown status, or a deprecation without a reason (`DEPRECATION_REASON_REQUIRED`) or without who (`DEPRECATED_BY_REQUIRED`)", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No template of that type", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/templates/{type}/outputs",
  tags: ["Internal"],
  summary: "The last outputs written with a template (subject + each email), newest first",
  description:
    `${staffNote} Every org. Serves only subject, each email's text, when, workflow and model: ` +
    "never org/lead ids, recipient fields, the raw prompt, the raw response or the variables.",
  request: {
    params: z.object({ type: z.string().describe("Template type, e.g. `cold-email-v59`") }),
    query: TemplateOutputsQuerySchema,
  },
  responses: {
    200: { description: "Outputs", content: { "application/json": { schema: TemplateOutputsResponseSchema } } },
    400: { description: "Bad limit", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No template of that type", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Template dynasties (TPL-DYNASTY-1021-CG) — src/lib/template-dynasties.ts
// ---------------------------------------------------------------------------

const dynastyNote =
  "Service/staff route: API key only, no identity headers. A template dynasty is one email strategy on ONE pipe " +
  "(featureSlug x legKey), cross-org. Its versions are stored templates in order; the HEAD (latest) is the template " +
  "every workflow on the dynasty writes with, and stats pool across its versions. Each generation still records the " +
  "exact version it used (`promptType`).";

const DynastySlugParam = z.object({ slug: z.string().describe("Dynasty slug, e.g. `cold-reply-intro-offer-blind`") });

const DynastyFields = {
  slug: z.string().describe("Unique, stable id of the dynasty."),
  name: z.string().describe("Short name, unique per pipe."),
  description: z.string().describe("One sentence shown to clients. Unique across the catalogue."),
  signature: z.string().describe("Internal: what makes this dynasty unique, the guideline every new version must respect. Unique per pipe."),
  identity: z.enum(DYNASTY_IDENTITIES).describe("`blind` = the email never names the client; `named` = it does. Never the model's choice."),
  featureSlug: z.string().describe("Pipe: the feature, e.g. `sales-cold-email-outreach`."),
  legKey: z.string().describe("Pipe: the leg, e.g. `lead_found_to_conversation`."),
};

export const TemplateDynastySchema = registry.register(
  "TemplateDynasty",
  z
    .object({
      ...DynastyFields,
      head: z.string().nullable().describe("Template type of the latest version: the one to write with. Null only for a dynasty with no version."),
      versions: z
        .array(
          z.object({
            type: z.string().describe("Template type (readable alone via GET /prompts?type=)."),
            position: z.number().int().describe("1 = oldest; the highest is the head."),
            status: z.enum(["active", "deprecated"]).describe("The template's own staff status."),
            addedAt: z.string(),
          })
        )
        .describe("Oldest first. A template type may also be a version of a dynasty on another pipe."),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi("TemplateDynasty")
);

export const ListTemplateDynastiesQuerySchema = z.object({
  featureSlug: z.string().optional().describe("Only dynasties of this feature"),
  legKey: z.string().optional().describe("Only dynasties of this leg"),
});

export const CreateTemplateDynastyRequestSchema = registry.register(
  "CreateTemplateDynastyRequest",
  z
    .object({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(300),
      signature: z.string().trim().min(1).max(1000),
      identity: z.enum(DYNASTY_IDENTITIES),
      featureSlug: z.string().min(1),
      legKey: z.string().min(1),
      versions: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Existing template types, oldest first; the last is the head. Exactly one of `versions` / `template`."),
      template: z
        .object({
          type: z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "type must be lowercase kebab-case")
            .optional()
            .describe("Type to store the new template under; default `<slug>-v1`. Later versions are `<family>-vN`."),
          prompt: z.string().min(1).describe("The full text of a brand-new template. Must differ from every stored template."),
          variables: z.array(PromptVariableSchema).describe("Exactly the {{tokens}} the text uses."),
        })
        .strict()
        .optional()
        .describe("A brand-new template, stored as the dynasty's first version and head. Exactly one of `versions` / `template`."),
    })
    .refine((b) => (b.versions === undefined) !== (b.template === undefined), {
      message: "send exactly one of `versions` (existing templates) or `template` (a new text)",
      path: ["versions"],
    })
    .openapi("CreateTemplateDynastyRequest")
);

export const AddTemplateDynastyVersionRequestSchema = registry.register(
  "AddTemplateDynastyVersionRequest",
  z
    .union([
      z
        .object({
          prompt: z.string().min(1).describe("The new version's full text. Must differ from every stored template."),
          variables: z.array(PromptVariableSchema).describe(
            "Exactly the {{tokens}} the text uses, each one declared by the current head (the workflows on the dynasty send those)."
          ),
        })
        .strict(),
      z
        .object({
          type: z.string().min(1).describe("An ALREADY-STORED template to append as the head (same checks; refused if already a version of this dynasty)."),
        })
        .strict(),
    ])
    .describe("Either a new text (`prompt` + `variables`) or an existing template (`type`).")
    .openapi("AddTemplateDynastyVersionRequest")
);

const TemplateDynastyWithTemplateSchema = registry.register(
  "TemplateDynastyWithTemplate",
  z
    .object({
      dynasty: TemplateDynastySchema,
      template: PromptResponseSchema.describe("The head's stored template."),
    })
    .openapi("TemplateDynastyWithTemplate")
);

const DynastyErrorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough();

registry.registerPath({
  method: "get",
  path: "/internal/template-dynasties",
  tags: ["Template dynasties"],
  summary: "List template dynasties, optionally of one pipe",
  description: dynastyNote,
  request: { query: ListTemplateDynastiesQuerySchema },
  responses: {
    200: {
      description: "Dynasties by slug",
      content: { "application/json": { schema: z.object({ dynasties: z.array(TemplateDynastySchema) }) } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/template-dynasties",
  tags: ["Template dynasties"],
  summary: "Create a dynasty, over existing templates or from a brand-new text",
  description:
    `${dynastyNote} Either \`versions\` (already-stored templates, the last listed is the head) or \`template\` ` +
    "(a new text + its variables, stored as the first version and head, under `template.type` or `<slug>-v1`). " +
    "A new text is judged like every stored template (brand/offer neutrality; the blind rule when the dynasty is blind), " +
    "in full, billed to the platform. Nothing is stored on any refusal.",
  request: { body: { content: { "application/json": { schema: CreateTemplateDynastyRequestSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TemplateDynastySchema } } },
    400: { description: "Invalid body (neither or both of `versions` / `template`), a template listed twice (`DUPLICATE_VERSION`) or unknown (`UNKNOWN_TEMPLATE`), or `template.variables` not exactly the text's tokens (`VARIABLES_MISMATCH`)", content: { "application/json": { schema: DynastyErrorSchema } } },
    409: { description: "`DYNASTY_CONFLICT`: slug or description taken, or name/signature taken on the same pipe (`field`, `dynastySlug`); `TEMPLATE_TYPE_TAKEN` (`type`); `TEMPLATE_TWIN`: the new text is byte-identical to the stored template `twinType`", content: { "application/json": { schema: DynastyErrorSchema } } },
    422: { description: "`TEMPLATE_NOT_NEUTRAL` or `BLIND_TEMPLATE_REVEALS_CLIENT`, with the `passages` refused", content: { "application/json": { schema: DynastyErrorSchema } } },
    502: { description: "`TEMPLATE_NEUTRALITY_CHECK_FAILED`: the judgment could not run (402/429 kept); nothing stored", content: { "application/json": { schema: DynastyErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/template-dynasties/{slug}",
  tags: ["Template dynasties"],
  summary: "One dynasty with its versions and head",
  description: dynastyNote,
  request: { params: DynastySlugParam },
  responses: {
    200: { description: "Dynasty", content: { "application/json": { schema: TemplateDynastySchema } } },
    404: { description: "`DYNASTY_NOT_FOUND`", content: { "application/json": { schema: DynastyErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/template-dynasties/{slug}/head",
  tags: ["Template dynasties"],
  summary: "The template to write with for a dynasty (its head)",
  description: `${dynastyNote} Send \`template.type\` as the /generate \`type\`.`,
  request: { params: DynastySlugParam },
  responses: {
    200: { description: "Dynasty + head template", content: { "application/json": { schema: TemplateDynastyWithTemplateSchema } } },
    404: { description: "`DYNASTY_NOT_FOUND`", content: { "application/json": { schema: DynastyErrorSchema } } },
    409: { description: "`DYNASTY_HAS_NO_VERSION`", content: { "application/json": { schema: DynastyErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/template-dynasties/{slug}/versions",
  tags: ["Template dynasties"],
  summary: "Add a version to a dynasty; it becomes the head",
  description:
    `${dynastyNote} The new template is stored under the next free \`<head family>-vN\` type. ` +
    "Judged like every stored template (brand/offer neutrality; the blind rule when the dynasty is blind), on what it adds to the head, billed to the platform.",
  request: {
    params: DynastySlugParam,
    body: { content: { "application/json": { schema: AddTemplateDynastyVersionRequestSchema } } },
  },
  responses: {
    201: { description: "Version added; `template` is the new head", content: { "application/json": { schema: TemplateDynastyWithTemplateSchema } } },
    400: { description: "Invalid body, a token the head does not declare (`VARIABLE_NOT_IN_HEAD`), variables not matching the text (`VARIABLES_MISMATCH`), or an unknown `type` (`UNKNOWN_TEMPLATE`)", content: { "application/json": { schema: DynastyErrorSchema } } },
    404: { description: "`DYNASTY_NOT_FOUND`", content: { "application/json": { schema: DynastyErrorSchema } } },
    409: { description: "`TEMPLATE_TWIN`: the text is byte-identical to another stored template `twinType`; `ALREADY_IN_DYNASTY`; or `DYNASTY_HAS_NO_VERSION`", content: { "application/json": { schema: DynastyErrorSchema } } },
    422: { description: "`TEMPLATE_NOT_NEUTRAL` or `BLIND_TEMPLATE_REVEALS_CLIENT`, with the passages", content: { "application/json": { schema: DynastyErrorSchema } } },
    502: { description: "`TEMPLATE_NEUTRALITY_CHECK_FAILED`: nothing stored", content: { "application/json": { schema: DynastyErrorSchema } } },
  },
});
