import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, templateDynasties, templateDynastyVersions } from "../db/schema.js";
import { outputEmails, type TemplateOutputEmail } from "./catalogue-status-query.js";
import { resolveWorkflowDynastySlugs } from "./dynasty-client.js";

/**
 * The last generations one WORKFLOW dynasty wrote, newest first, every org (WF-RUNS-OUTPUTS-1022).
 * A workflow no longer fixes its template or LLM (each send uses the leg's best ones), so each
 * output says which template (dynasty + version) and which model wrote it. The dynasty's version
 * slugs are workflow-service's; the rows are ours. Never an org, brand, campaign, audience or lead.
 */
export interface WorkflowDynastyOutput {
  generationId: string;
  createdAt: string;
  /** The workflow run that asked for it. */
  runId: string;
  /** The workflow VERSION slug. */
  workflowSlug: string;
  /** The exact template version that wrote it. */
  promptType: string | null;
  /** The template dynasty that version belongs to; null for a template in no dynasty. */
  templateDynasty: { slug: string; name: string; position: number } | null;
  /** The concrete model id. */
  model: string;
  subject: string | null;
  emails: TemplateOutputEmail[];
}

export async function readWorkflowDynastyOutputs(slug: string, limit: number): Promise<WorkflowDynastyOutput[]> {
  const workflowSlugs = await resolveWorkflowDynastySlugs(slug);
  if (workflowSlugs.length === 0) return [];
  const g = emailGenerations;
  const v = templateDynastyVersions;
  const d = templateDynasties;
  const rows = await db
    .select({
      id: g.id,
      createdAt: g.createdAt,
      runId: g.runId,
      workflowSlug: g.workflowSlug,
      promptType: g.promptType,
      model: g.model,
      subject: g.subject,
      bodyText: g.bodyText,
      bodyHtml: g.bodyHtml,
      sequence: g.sequence,
      dynastySlug: d.slug,
      dynastyName: d.name,
      position: v.position,
    })
    .from(g)
    .leftJoin(v, eq(v.promptType, g.promptType))
    .leftJoin(d, eq(d.slug, v.dynastySlug))
    .where(inArray(g.workflowSlug, workflowSlugs))
    .orderBy(desc(g.createdAt), desc(g.id))
    .limit(limit);
  return rows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    runId: r.runId,
    workflowSlug: r.workflowSlug!,
    promptType: r.promptType,
    templateDynasty: r.dynastySlug && r.dynastyName && r.position !== null
      ? { slug: r.dynastySlug, name: r.dynastyName, position: r.position }
      : null,
    model: r.model,
    subject: r.subject,
    emails: outputEmails(r),
  }));
}
