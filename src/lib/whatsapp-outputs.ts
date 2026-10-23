/**
 * The last WhatsApp messages written with some template types (whatsapp_generations, WA-TEMPLATES-1023),
 * in the shape of a template's outputs: no subject, one entry whose text is the bubbles separated by one
 * empty line. Only messages that were sent (decision write). Merged into the template and dynasty outputs
 * so a WhatsApp dynasty reads like an email one on the staff pages.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { whatsappGenerations } from "../db/schema.js";
import type { TemplateOutput } from "./catalogue-status-query.js";

export async function readWhatsAppOutputs(types: string[], limit: number): Promise<Array<TemplateOutput & { promptType: string }>> {
  if (types.length === 0) return [];
  const w = whatsappGenerations;
  const rows = await db
    .select({ id: w.id, createdAt: w.createdAt, promptType: w.promptType, workflowSlug: w.workflowSlug, model: w.model, bubbles: w.bubbles })
    .from(w)
    .where(and(inArray(w.promptType, types), eq(w.decision, "write")))
    .orderBy(desc(w.createdAt), desc(w.id))
    .limit(limit);
  return rows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    promptType: r.promptType,
    workflowSlug: r.workflowSlug,
    model: r.model,
    subject: null,
    emails: [{ step: 1, bodyText: (Array.isArray(r.bubbles) ? r.bubbles : []).join("\n\n"), daysSinceLastStep: 0 }],
  }));
}

/** Newest first across both sources, at most `limit`. */
export function newestFirst<T extends { createdAt: string; generationId: string }>(a: T[], b: T[], limit: number): T[] {
  return [...a, ...b]
    .sort((x, y) => (x.createdAt === y.createdAt ? (x.generationId < y.generationId ? 1 : -1) : x.createdAt < y.createdAt ? 1 : -1))
    .slice(0, limit);
}
