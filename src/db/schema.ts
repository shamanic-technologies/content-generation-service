import { pgTable, uuid, text, timestamp, uniqueIndex, index, integer, jsonb, boolean } from "drizzle-orm/pg-core";

// Email generations
export const emailGenerations = pgTable(
  "email_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: text("run_id").notNull(),
    apolloEnrichmentId: text("apollo_enrichment_id"),
    promptType: text("prompt_type"), // which stored prompt was used

    // Lead info (for context / dashboard display)
    leadFirstName: text("lead_first_name"),
    leadLastName: text("lead_last_name"),
    leadCompany: text("lead_company"),
    leadTitle: text("lead_title"),
    leadIndustry: text("lead_industry"),
    leadOrganizationDomain: text("lead_organization_domain"),

    // Client info (for context / dashboard display)
    clientCompanyName: text("client_company_name"),
    clientCompanyDescription: text("client_company_description"),

    // Full variable data for audit
    variablesRaw: jsonb("variables_raw"),

    // External references
    brandIds: text("brand_ids").array().notNull(),
    campaignId: text("campaign_id").notNull(),

    // Link to runs-service generation run for cost tracking
    generationRunId: text("generation_run_id"),

    // Generated email sequence
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    sequence: jsonb("sequence"),

    // Model info (kept for operational metadata)
    model: text("model").notNull().default("claude-sonnet-4-6"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),

    // Raw data for debugging
    promptRaw: text("prompt_raw"),
    responseRaw: jsonb("response_raw"),

    // Workflow tracking
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),

    // Lead tracking — lead-service correlation ID
    leadId: text("lead_id"),

    // Idempotency support — caller-supplied key to prevent duplicate generations
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_emailgen_org").on(table.orgId),
    index("idx_emailgen_run").on(table.runId),
    index("idx_emailgen_enrichment").on(table.apolloEnrichmentId),
    index("idx_emailgen_campaign").on(table.campaignId),
    index("idx_emailgen_brand_ids").using("gin", table.brandIds),
    uniqueIndex("idx_emailgen_idempotency").on(table.orgId, table.idempotencyKey),
    uniqueIndex("idx_emailgen_lead").on(table.campaignId, table.leadId),
  ]
);

// Prompt templates — type is the unique identifier (like an ID).
// orgId is optional traceability: records who created the prompt, but does NOT scope visibility.
// All prompts are globally accessible regardless of orgId.
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id"), // nullable: traceability only (who created it)
    type: text("type").notNull(),
    prompt: text("prompt").notNull(), // template text with {{variables}}
    variables: jsonb("variables").$type<Array<{ name: string; description: string }>>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_prompts_type").on(table.type),
  ]
);

// Per-feature prompt assignment — maps a feature slug to the prompt type rendered
// when generating for that feature. Feature-global (NOT org/brand-scoped): the
// assignment is brand-agnostic, brand facts arrive via the {{brand}} variable at
// generation time. Absence of a row means the feature resolves to the platform default.
export const featurePromptAssignment = pgTable("feature_prompt_assignment", {
  featureSlug: text("feature_slug").primaryKey(),
  promptType: text("prompt_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** @deprecated No longer used after calendar/content endpoint removal. Kept for historical data. */
export const contentGenerations = pgTable(
  "content_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    type: text("type").notNull(), // "email" | "calendar"

    // Input
    prompt: text("prompt").notNull(),
    variables: jsonb("variables"), // string[] | null
    includeFooter: boolean("include_footer"),

    // Output — email
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),

    // Output — calendar
    title: text("title"),
    description: text("description"),
    location: text("location"),

    // Cost tracking
    generationRunId: text("generation_run_id"),

    // Workflow tracking
    workflowSlug: text("workflow_slug"),

    // Model metadata
    model: text("model").notNull().default("claude-sonnet-4-6"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),

    // Raw data for debugging
    promptRaw: text("prompt_raw"),
    responseRaw: jsonb("response_raw"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_contentgen_org").on(table.orgId),
  ]
);

export type EmailGeneration = typeof emailGenerations.$inferSelect;
export type NewEmailGeneration = typeof emailGenerations.$inferInsert;
/** @deprecated */
export type ContentGeneration = typeof contentGenerations.$inferSelect;
/** @deprecated */
export type NewContentGeneration = typeof contentGenerations.$inferInsert;
export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
export type FeaturePromptAssignment = typeof featurePromptAssignment.$inferSelect;
export type NewFeaturePromptAssignment = typeof featurePromptAssignment.$inferInsert;
