import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { templateDynasties } from "../db/schema.js";
import type { TemplateOutputEmail } from "./catalogue-status-query.js";
import { pairsOfEngineLive } from "./engine-catalogue.js";
import { resolveModelDynastyVersions } from "./model-dynasty-client.js";
import { readOutputsOnTemplateDynasties } from "./model-dynasty-outputs.js";

/**
 * The last messages one LLM dynasty (every version) wrote for ONE Engine, newest first, every org and template
 * (RESEARCH-BY-ENGINE-1113-CG). Staff Research > an Engine > LLMs > one LLM.
 *
 * - The Engine of a message = the Engine of the template dynasty its exact template version belongs to; a template
 *   dynasty states a (featureSlug, legKey) pair, whose Engine is features-service's catalogue's (`engine-catalogue.ts`).
 *   A template in no dynasty is on no Engine.
 * - Email, WhatsApp (sent) and Threads (not a dry run) messages, merged newest first.
 * - Served words: no pipe, leg, channel, play or workflow. `medium` says which kind of message.
 * Never an org, brand, campaign, audience or lead.
 */
export interface EngineModelOutput {
  generationId: string;
  createdAt: string;
  medium: "email" | "whatsapp" | "threads";
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

export async function readEngineModelOutputs(q: { engine: string; slug: string; limit: number }): Promise<{ name: string; modelIds: string[]; outputs: EngineModelOutput[] }> {
  const d = templateDynasties;
  const dynasties = await db.select({ slug: d.slug, featureSlug: d.featureSlug, legKey: d.legKey }).from(d);
  const slugs = (await pairsOfEngineLive(dynasties, q.engine)).map((x) => x.slug);
  if (slugs.length === 0) {
    const { name, modelIds } = await resolveModelDynastyVersions(q.slug);
    return { name, modelIds, outputs: [] };
  }
  const { name, modelIds, outputs } = await readOutputsOnTemplateDynasties(q.slug, inArray(d.slug, slugs), q.limit);
  return {
    name,
    modelIds,
    outputs: outputs.map((o) => ({
      generationId: o.generationId,
      createdAt: o.createdAt,
      medium: o.channel,
      promptType: o.promptType,
      templateDynasty: o.templateDynasty,
      model: o.model,
      tokensInput: o.tokensInput,
      tokensOutput: o.tokensOutput,
      subject: o.subject,
      emails: o.emails,
    })),
  };
}
