import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, templateDynasties, templateDynastyVersions, threadGenerations, whatsappGenerations } from "../db/schema.js";
import { outputEmails, type TemplateOutputEmail } from "./catalogue-status-query.js";
import { resolveModelDynastyVersions } from "./model-dynasty-client.js";
import { newestFirst } from "./whatsapp-outputs.js";

/**
 * The last messages one LLM dynasty (every version) wrote on ONE pipe, newest first, every org
 * (MODEL-OUTPUTS-1024-CG). Staff Research > a pipe > Models.
 *
 * - The dynasty's versions are chat-service's (`resolveModelDynastyVersions`); the rows are ours.
 * - The pipe of a message is the pipe of the template dynasty its exact template version belongs to
 *   (one template = one dynasty = one pipe), the same version membership features-service pools
 *   Research by. A generation records no leg itself, so a message whose template sits in no dynasty
 *   is on no pipe. Texts written before `drizzle/0038` split the shared ones read on the reply pipe.
 * - Email, WhatsApp (sent) and Threads (not a staff dry run) messages, merged newest first.
 * Never an org, brand, campaign, audience or lead.
 */
export interface ModelDynastyOutput {
  generationId: string;
  createdAt: string;
  channel: "email" | "whatsapp" | "threads";
  /** The workflow VERSION slug whose run asked for it. */
  workflowSlug: string | null;
  /** The exact template version that wrote it. */
  promptType: string;
  templateDynasty: { slug: string; name: string; position: number };
  /** The concrete model id (the dynasty version). */
  model: string;
  tokensInput: number | null;
  tokensOutput: number | null;
  subject: string | null;
  emails: TemplateOutputEmail[];
}

export interface ModelDynastyOutputsQuery {
  slug: string;
  featureSlug: string;
  legKey: string;
  limit: number;
}

export async function readModelDynastyOutputs(q: ModelDynastyOutputsQuery): Promise<{ name: string; modelIds: string[]; outputs: ModelDynastyOutput[] }> {
  const d = templateDynasties;
  return readOutputsOnTemplateDynasties(q.slug, and(eq(d.featureSlug, q.featureSlug), eq(d.legKey, q.legKey))!, q.limit);
}

/**
 * The last messages one LLM dynasty (every version) wrote with a template version of the template dynasties `onDynasties`
 * keeps (a condition on `template_dynasties`), newest first, every org: email, WhatsApp (sent) and Threads (not a dry
 * run). Shared by the per-pair read above and the per-Engine read (`engine-model-outputs.ts`).
 */
export async function readOutputsOnTemplateDynasties(
  slug: string,
  onDynasties: SQL,
  limit: number,
): Promise<{ name: string; modelIds: string[]; outputs: ModelDynastyOutput[] }> {
  const { name, modelIds } = await resolveModelDynastyVersions(slug);
  const q = { limit };
  const v = templateDynastyVersions;
  const d = templateDynasties;
  const onPipe = onDynasties;

  // One index walk per version (`idx_emailgen_model_created`), newest first, stopping at `limit`:
  // a single `model IN (...)` read scans every row of the dynasty before sorting.
  const g = emailGenerations;
  const emailRowsPerModel = await Promise.all(
    modelIds.map((model) =>
      db
        .select({
          id: g.id,
          createdAt: g.createdAt,
          workflowSlug: g.workflowSlug,
          promptType: g.promptType,
          model: g.model,
          tokensInput: g.tokensInput,
          tokensOutput: g.tokensOutput,
          subject: g.subject,
          bodyText: g.bodyText,
          bodyHtml: g.bodyHtml,
          sequence: g.sequence,
          dynastySlug: d.slug,
          dynastyName: d.name,
          position: v.position,
        })
        .from(g)
        .innerJoin(v, eq(v.promptType, g.promptType))
        .innerJoin(d, eq(d.slug, v.dynastySlug))
        .where(and(eq(g.model, model), onPipe))
        .orderBy(desc(g.createdAt), desc(g.id))
        .limit(q.limit)
    )
  );
  const emailRows = emailRowsPerModel.flat();

  const w = whatsappGenerations;
  const waRows = await db
    .select({
      id: w.id,
      createdAt: w.createdAt,
      workflowSlug: w.workflowSlug,
      promptType: w.promptType,
      model: w.model,
      tokensInput: w.tokensInput,
      tokensOutput: w.tokensOutput,
      bubbles: w.bubbles,
      dynastySlug: d.slug,
      dynastyName: d.name,
      position: v.position,
    })
    .from(w)
    .innerJoin(v, eq(v.promptType, w.promptType))
    .innerJoin(d, eq(d.slug, v.dynastySlug))
    .where(and(inArray(w.model, modelIds), eq(w.decision, "write"), onPipe))
    .orderBy(desc(w.createdAt), desc(w.id))
    .limit(q.limit);

  const emails: ModelDynastyOutput[] = emailRows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    channel: "email",
    workflowSlug: r.workflowSlug,
    promptType: r.promptType!,
    templateDynasty: { slug: r.dynastySlug, name: r.dynastyName, position: r.position },
    model: r.model,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    subject: r.subject,
    emails: outputEmails(r),
  }));
  const whatsapp: ModelDynastyOutput[] = waRows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    channel: "whatsapp",
    workflowSlug: r.workflowSlug,
    promptType: r.promptType,
    templateDynasty: { slug: r.dynastySlug, name: r.dynastyName, position: r.position },
    model: r.model,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    subject: null,
    emails: [{ step: 1, bodyText: (Array.isArray(r.bubbles) ? r.bubbles : []).join("\n\n"), daysSinceLastStep: 0 }],
  }));
  const t = threadGenerations;
  const threadRows = await db
    .select({
      id: t.id,
      createdAt: t.createdAt,
      workflowSlug: t.workflowSlug,
      promptType: t.promptType,
      model: t.model,
      tokensInput: t.tokensInput,
      tokensOutput: t.tokensOutput,
      subject: t.subject,
      post: t.post,
      replies: t.replies,
      dynastySlug: d.slug,
      dynastyName: d.name,
      position: v.position,
    })
    .from(t)
    .innerJoin(v, eq(v.promptType, t.promptType))
    .innerJoin(d, eq(d.slug, v.dynastySlug))
    .where(and(inArray(t.model, modelIds), eq(t.dryRun, false), onPipe))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(q.limit);
  const threads: ModelDynastyOutput[] = threadRows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    channel: "threads",
    workflowSlug: r.workflowSlug,
    promptType: r.promptType,
    templateDynasty: { slug: r.dynastySlug, name: r.dynastyName, position: r.position },
    model: r.model,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    subject: r.subject,
    emails: [r.post, ...(Array.isArray(r.replies) ? (r.replies as string[]) : [])].map((bodyText, i) => ({ step: i + 1, bodyText, daysSinceLastStep: 0 })),
  }));
  return { name, modelIds, outputs: newestFirst(newestFirst(emails, whatsapp, q.limit), threads, q.limit) };
}
