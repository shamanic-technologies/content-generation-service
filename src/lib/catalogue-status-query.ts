import { readWhatsAppOutputs, newestFirst } from "./whatsapp-outputs.js";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, modelPipeStatuses, prompts } from "../db/schema.js";
import type { ChatModel, ChatProvider } from "./chat-models.js";
import { listChatModels, type ChatModelEntry } from "./chat-model-catalogue.js";
import { servedStatus, type ModelPipe, type ServedStatus, type StatusChange } from "./catalogue-status.js";
import { resolveGenerationBody } from "./generation-body.js";
import { dynastyKey, dynastyMembers, dynastyStatusAlignment, effectiveDynastyPipeRows } from "./model-dynasty-status.js";

/**
 * Reads and writes behind the staff catalogue-status routes (src/routes/catalogue-status.ts).
 * See src/lib/catalogue-status.ts for what a status means and who reads it.
 */

export interface ModelPipeStatus extends ServedStatus {
  featureSlug: string;
  legKey: string;
}

export interface ModelStatusEntry extends ServedStatus {
  model: ChatModel;
  provider: ChatProvider;
  dynasty: string | null;
  /** The pipe the top-level status is for; null = asked without a pipe (always active: no global status). */
  pipe: ModelPipe | null;
  /** Every pipe where staff stated this model's status, oldest change first. */
  pipeStatuses: ModelPipeStatus[];
}

const ACTIVE = { status: "active" as const, statusReason: null, statusChangedBy: null, statusChangedAt: null };

type PipeRow = typeof modelPipeStatuses.$inferSelect;

const toPipeStatus = (r: PipeRow): ModelPipeStatus => ({ featureSlug: r.featureSlug, legKey: r.legKey, ...servedStatus(r) });

const readPipeRows = () => db.select().from(modelPipeStatuses).orderBy(asc(modelPipeStatuses.statusChangedAt));

/**
 * Every name chat-service accepts, in its catalogue order, with its DYNASTY's status on `pipe`
 * (no row = active there) and every pipe staff stated a status on for that dynasty
 * (LLM-DYNASTY-DEPRECATE-1025, src/lib/model-dynasty-status.ts). Without a pipe the
 * top-level status is `active`: a model is never retired fleet-wide (LLM-STATUS-PER-PIPE-1023).
 */
export async function listModelStatuses(pipe: ModelPipe | null = null): Promise<ModelStatusEntry[]> {
  const [catalogue, rows] = await Promise.all([listChatModels(), readPipeRows()]);
  const byDynasty = effectiveDynastyPipeRows(catalogue, rows);
  return catalogue.map((entry) => {
    const { model, provider, dynasty } = entry;
    const own = byDynasty.get(dynastyKey(entry)) ?? [];
    const onPipe = pipe ? own.find((r) => r.featureSlug === pipe.featureSlug && r.legKey === pipe.legKey) : undefined;
    return { model, provider, dynasty, ...servedStatus(onPipe ?? ACTIVE), pipe, pipeStatuses: own.map(toPipeStatus) };
  });
}

/**
 * Sets the status of the model's whole DYNASTY on ONE pipe: every name chat-service accepts
 * for that dynasty gets the same status, reason, author and instant, in one transaction.
 * Every other pipe is untouched.
 */
export async function setModelStatus(entry: ChatModelEntry, pipe: ModelPipe, change: StatusChange): Promise<ModelStatusEntry> {
  const { model, provider, dynasty } = entry;
  const names = dynastyMembers(await listChatModels(), entry);
  const set = { status: change.status, statusReason: change.reason, statusChangedBy: change.changedBy, statusChangedAt: new Date() };
  await db.transaction(async (tx) => {
    for (const name of names) {
      await tx
        .insert(modelPipeStatuses)
        .values({ model: name, featureSlug: pipe.featureSlug, legKey: pipe.legKey, ...set })
        .onConflictDoUpdate({ target: [modelPipeStatuses.model, modelPipeStatuses.featureSlug, modelPipeStatuses.legKey], set });
    }
  });
  const own = effectiveDynastyPipeRows([...(await listChatModels()), entry], await readPipeRows()).get(dynastyKey(entry)) ?? [];
  const onPipe = own.find((r) => r.featureSlug === pipe.featureSlug && r.legKey === pipe.legKey)!;
  return { model, provider, dynasty, ...servedStatus(onPipe), pipe, pipeStatuses: own.map(toPipeStatus) };
}

/**
 * Writes the rows a split dynasty is missing (a name chat-service added since, rows written
 * one name at a time before LLM-DYNASTY-DEPRECATE-1025): each name gets its dynasty's most
 * recent change on each pipe. Idempotent; returns the number of rows written.
 */
export async function alignModelDynastyStatuses(): Promise<number> {
  const [catalogue, rows] = await Promise.all([listChatModels(), readPipeRows()]);
  const writes = dynastyStatusAlignment(catalogue, rows);
  if (writes.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const w of writes) {
      const set = { status: w.status, statusReason: w.statusReason, statusChangedBy: w.statusChangedBy, statusChangedAt: w.statusChangedAt };
      await tx
        .insert(modelPipeStatuses)
        .values({ model: w.model, featureSlug: w.featureSlug, legKey: w.legKey, ...set })
        .onConflictDoUpdate({ target: [modelPipeStatuses.model, modelPipeStatuses.featureSlug, modelPipeStatuses.legKey], set });
    }
  });
  return writes.length;
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
