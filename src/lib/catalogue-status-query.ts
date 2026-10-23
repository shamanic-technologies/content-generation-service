import { readWhatsAppOutputs, newestFirst } from "./whatsapp-outputs.js";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, modelStatuses, prompts } from "../db/schema.js";
import type { ChatModel, ChatProvider } from "./chat-models.js";
import { listChatModels, type ChatModelEntry } from "./chat-model-catalogue.js";
import { servedStatus, type ServedStatus, type StatusChange } from "./catalogue-status.js";
import { resolveGenerationBody } from "./generation-body.js";

/**
 * Reads and writes behind the staff catalogue-status routes (src/routes/catalogue-status.ts).
 * See src/lib/catalogue-status.ts for what a status means and who reads it.
 */

export interface ModelStatusEntry extends ServedStatus {
  model: ChatModel;
  provider: ChatProvider;
  dynasty: string | null;
}

/** Every name chat-service accepts, in its catalogue order. No row = active (never changed). */
export async function listModelStatuses(): Promise<ModelStatusEntry[]> {
  const [catalogue, rows] = await Promise.all([listChatModels(), db.select().from(modelStatuses)]);
  const byModel = new Map(rows.map((r) => [r.model, r]));
  return catalogue.map(({ model, provider, dynasty }) => {
    const row = byModel.get(model);
    return {
      model,
      provider,
      dynasty,
      ...servedStatus(row ?? { status: "active", statusReason: null, statusChangedBy: null, statusChangedAt: null }),
    };
  });
}

export async function setModelStatus(entry: ChatModelEntry, change: StatusChange): Promise<ModelStatusEntry> {
  const { model, provider, dynasty } = entry;
  const now = new Date();
  const set = { status: change.status, statusReason: change.reason, statusChangedBy: change.changedBy, statusChangedAt: now };
  const [row] = await db
    .insert(modelStatuses)
    .values({ model, ...set })
    .onConflictDoUpdate({ target: modelStatuses.model, set })
    .returning();
  return { model, provider, dynasty, ...servedStatus(row) };
}

export interface TemplateStatusEntry extends ServedStatus {
  type: string;
}

const templateStatusColumns = () => ({
  type: prompts.type,
  status: prompts.status,
  statusReason: prompts.statusReason,
  statusChangedBy: prompts.statusChangedBy,
  statusChangedAt: prompts.statusChangedAt,
});

function toTemplateStatus(r: { type: string } & Parameters<typeof servedStatus>[0]): TemplateStatusEntry {
  return { type: r.type, ...servedStatus(r) };
}

/** Every stored template's status, by type. Bodies are not read. */
export async function listTemplateStatuses(): Promise<TemplateStatusEntry[]> {
  const rows = await db.select(templateStatusColumns()).from(prompts).orderBy(asc(prompts.type));
  return rows.map(toTemplateStatus);
}

/** Sets the status only (body, variables and updated_at untouched). `null` = no such type. */
export async function setTemplateStatus(type: string, change: StatusChange): Promise<TemplateStatusEntry | null> {
  const [row] = await db
    .update(prompts)
    .set({ status: change.status, statusReason: change.reason, statusChangedBy: change.changedBy, statusChangedAt: sql`now()` })
    .where(eq(prompts.type, type))
    .returning(templateStatusColumns());
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

  const emails = rows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    workflowSlug: r.workflowSlug,
    model: r.model,
    subject: r.subject,
    emails: outputEmails(r),
  }));
  // A WhatsApp template's messages (WA-TEMPLATES-1023); empty for an email template.
  const whatsapp = (await readWhatsAppOutputs([type], limit)).map(({ promptType: _, ...o }) => o);
  return newestFirst(emails, whatsapp, limit);
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
