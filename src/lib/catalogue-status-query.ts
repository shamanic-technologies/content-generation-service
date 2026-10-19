import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, modelStatuses, prompts } from "../db/schema.js";
import { CHAT_MODELS, MODEL_TO_PROVIDER, type ChatModel, type ChatProvider } from "./chat-models.js";
import type { CatalogueStatus } from "./catalogue-status.js";
import { resolveGenerationBody } from "./generation-body.js";

/**
 * Reads and writes behind the staff catalogue-status routes (src/routes/catalogue-status.ts).
 * See src/lib/catalogue-status.ts for what a status means and who reads it.
 */

export interface ModelStatusEntry {
  model: ChatModel;
  provider: ChatProvider;
  status: CatalogueStatus;
  statusChangedAt: string | null;
}

/** Every alias this service accepts, in CHAT_MODELS order. No row = active (never changed). */
export async function listModelStatuses(): Promise<ModelStatusEntry[]> {
  const rows = await db.select().from(modelStatuses);
  const byModel = new Map(rows.map((r) => [r.model, r]));
  return CHAT_MODELS.map((model) => {
    const row = byModel.get(model);
    return {
      model,
      provider: MODEL_TO_PROVIDER[model],
      status: row ? row.status : "active",
      statusChangedAt: row ? row.statusChangedAt.toISOString() : null,
    };
  });
}

export async function setModelStatus(model: ChatModel, status: CatalogueStatus): Promise<ModelStatusEntry> {
  const now = new Date();
  const [row] = await db
    .insert(modelStatuses)
    .values({ model, status, statusChangedAt: now })
    .onConflictDoUpdate({ target: modelStatuses.model, set: { status, statusChangedAt: now } })
    .returning();
  return {
    model,
    provider: MODEL_TO_PROVIDER[model],
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
  };
}

export interface TemplateStatusEntry {
  type: string;
  status: CatalogueStatus;
  statusChangedAt: string | null;
}

function toTemplateStatus(r: { type: string; status: CatalogueStatus; statusChangedAt: Date | null }): TemplateStatusEntry {
  return { type: r.type, status: r.status, statusChangedAt: r.statusChangedAt ? r.statusChangedAt.toISOString() : null };
}

/** Every stored template's status, by type. Bodies are not read. */
export async function listTemplateStatuses(): Promise<TemplateStatusEntry[]> {
  const rows = await db
    .select({ type: prompts.type, status: prompts.status, statusChangedAt: prompts.statusChangedAt })
    .from(prompts)
    .orderBy(asc(prompts.type));
  return rows.map(toTemplateStatus);
}

/** Sets the status only (body, variables and updated_at untouched). `null` = no such type. */
export async function setTemplateStatus(type: string, status: CatalogueStatus): Promise<TemplateStatusEntry | null> {
  const [row] = await db
    .update(prompts)
    .set({ status, statusChangedAt: sql`now()` })
    .where(eq(prompts.type, type))
    .returning({ type: prompts.type, status: prompts.status, statusChangedAt: prompts.statusChangedAt });
  return row ? toTemplateStatus(row) : null;
}

export async function templateExists(type: string): Promise<boolean> {
  const [row] = await db.select({ type: prompts.type }).from(prompts).where(eq(prompts.type, type)).limit(1);
  return Boolean(row);
}

export interface TemplateOutputEmail {
  step: number;
  bodyText: string;
  daysSinceLastStep: number | null;
}

export interface TemplateOutput {
  generationId: string;
  createdAt: string;
  workflowSlug: string | null;
  model: string;
  subject: string | null;
  emails: TemplateOutputEmail[];
}

/**
 * The last `limit` generations written with one template type, newest first, every org.
 * Only what a staff reader needs: subject, each email's text, when, which workflow and model.
 * Never org/lead ids, recipient fields, the raw prompt, the raw response or the variables.
 */
export async function readTemplateOutputs(type: string, limit: number): Promise<TemplateOutput[]> {
  const g = emailGenerations;
  const rows = await db
    .select({
      id: g.id,
      createdAt: g.createdAt,
      workflowSlug: g.workflowSlug,
      model: g.model,
      subject: g.subject,
      bodyText: g.bodyText,
      bodyHtml: g.bodyHtml,
      sequence: g.sequence,
    })
    .from(g)
    .where(eq(g.promptType, type))
    .orderBy(desc(g.createdAt), desc(g.id))
    .limit(limit);

  return rows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    workflowSlug: r.workflowSlug,
    model: r.model,
    subject: r.subject,
    emails: outputEmails(r),
  }));
}

/** Each step of the stored sequence; a pre-sequence row (copy in the body columns) is one email. */
export function outputEmails(r: { bodyText: string | null; bodyHtml: string | null; sequence: unknown }): TemplateOutputEmail[] {
  if (Array.isArray(r.sequence) && r.sequence.length > 0) {
    return r.sequence.map((s: { step?: unknown; bodyText?: unknown; daysSinceLastStep?: unknown }, i: number) => ({
      step: typeof s.step === "number" ? s.step : i + 1,
      bodyText: typeof s.bodyText === "string" ? s.bodyText : "",
      daysSinceLastStep: typeof s.daysSinceLastStep === "number" ? s.daysSinceLastStep : null,
    }));
  }
  const body = resolveGenerationBody({ bodyText: r.bodyText, bodyHtml: r.bodyHtml, sequence: r.sequence });
  return body.bodyText ? [{ step: 1, bodyText: body.bodyText, daysSinceLastStep: 0 }] : [];
}
