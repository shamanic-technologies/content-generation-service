import { pgTable, uuid, text, timestamp, uniqueIndex, index, integer, jsonb, boolean } from "drizzle-orm/pg-core";

// Local users table (maps to Clerk)
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_clerk_id").on(table.clerkUserId),
  ]
);

// Local orgs table (maps to Clerk)
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkOrgId: text("clerk_org_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_clerk_id").on(table.clerkOrgId),
  ]
);

// Email generations
export const emailGenerations = pgTable(
  "email_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    apolloEnrichmentId: text("apollo_enrichment_id"),
    promptType: text("prompt_type"), // which stored prompt was used

    // Lead info (for context / dashboard display)
    leadFirstName: text("lead_first_name"),
    leadLastName: text("lead_last_name"),
    leadCompany: text("lead_company"),
    leadTitle: text("lead_title"),
    leadIndustry: text("lead_industry"),

    // Client info (for context / dashboard display)
    clientCompanyName: text("client_company_name"),
    clientCompanyDescription: text("client_company_description"),

    // Full variable data for audit
    variablesRaw: jsonb("variables_raw"),

    // External references
    appId: text("app_id").notNull(),
    brandId: text("brand_id").notNull(),
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
    workflowName: text("workflow_name"),

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
    uniqueIndex("idx_emailgen_idempotency").on(table.orgId, table.idempotencyKey),
    uniqueIndex("idx_emailgen_lead").on(table.campaignId, table.leadId),
  ]
);

// Prompt templates (registered by apps at startup)
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: text("app_id").notNull(),
    type: text("type").notNull(), // "email" | "calendar" | custom types
    prompt: text("prompt").notNull(), // template text with {{variables}}
    variables: jsonb("variables").$type<string[]>().notNull().default([]), // expected variable names
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_prompts_app_type").on(table.appId, table.type),
  ]
);

// Content generations (generic prompt-based)
export const contentGenerations = pgTable(
  "content_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(),
    type: text("type").notNull(), // "email" | "calendar"
    keyMode: text("key_mode").notNull(), // "byok" | "app"

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
    parentRunId: text("parent_run_id"),

    // Workflow tracking
    workflowName: text("workflow_name"),

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
    index("idx_contentgen_app").on(table.appId),
  ]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type EmailGeneration = typeof emailGenerations.$inferSelect;
export type NewEmailGeneration = typeof emailGenerations.$inferInsert;
export type ContentGeneration = typeof contentGenerations.$inferSelect;
export type NewContentGeneration = typeof contentGenerations.$inferInsert;
export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
