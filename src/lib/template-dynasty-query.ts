import { readWhatsAppOutputs, newestFirst } from "./whatsapp-outputs.js";
import { readThreadOutputs } from "./thread-generations-query.js";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, prompts, templateDynasties, templateDynastyVersions } from "../db/schema.js";
import { servedStatus } from "./catalogue-status.js";
export { assertMayActivate, assertNotDynastySource } from "./dynasty-membership.js";
import { dynastiesHolding } from "./dynasty-membership.js";
import { outputEmails, type TemplateOutput } from "./catalogue-status-query.js";
import { findNextVersionType } from "./prompt-versioning.js";
import { assertTemplateKeepsDynastyIdentity, assertTemplateNeutral } from "./template-neutrality-guard.js";
import type { JudgmentCaller } from "./judgments-client.js";
import {
  TemplateDynastyError,
  UPGRADED_BY_SYSTEM,
  UPGRADED_REASON,
  applyDynastyStatus,
  assertMergeable,
  assertVariablesMatchText,
  assertVersionVariables,
  dynastyMerged,
  dynastyNotFound,
  mergedReason,
  templateTwin,
  type DynastyIdentity,
  type DynastyResponse,
  type MergedDynasty,
  type TemplateVariable,
  templateInOtherDynasty,
} from "./template-dynasties.js";

/** Reads and writes behind src/routes/template-dynasties.ts. Rules: template-dynasties.ts. */

type DynastyRow = typeof templateDynasties.$inferSelect;
type PromptRow = typeof prompts.$inferSelect;
type Executor = Pick<typeof db, "execute">;

/**
 * Deprecate (reason UPGRADED_REASON) every ACTIVE template that is a version of some dynasty and
 * not its head. `onlyTypes` narrows it (a new head: the previous head only). Returns the types
 * deprecated.
 */
export async function deprecateUpgradedVersions(
  executor: Executor,
  params: { changedBy: string; onlyTypes?: string[]; dryRun?: boolean },
): Promise<string[]> {
  const { changedBy, onlyTypes, dryRun } = params;
  if (onlyTypes && onlyTypes.length === 0) return [];
  const narrow = onlyTypes ? sql`AND p.type IN (${sql.join(onlyTypes.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const upgraded = sql`
    SELECT p.type FROM prompts p
    WHERE p.status = 'active'
      AND EXISTS (SELECT 1 FROM template_dynasty_versions v WHERE v.prompt_type = p.type)
      AND NOT EXISTS (
        SELECT 1 FROM template_dynasty_versions v
        WHERE v.prompt_type = p.type
          AND v.position = (SELECT MAX(h.position) FROM template_dynasty_versions h WHERE h.dynasty_slug = v.dynasty_slug)
      )
      ${narrow}`;
  const rows = dryRun
    ? await executor.execute(upgraded)
    : await executor.execute(sql`
        UPDATE prompts SET status = 'deprecated', status_reason = ${UPGRADED_REASON},
          status_changed_by = ${changedBy}, status_changed_at = now()
        WHERE type IN (${upgraded})
        RETURNING type`);
  return (rows as unknown as Array<{ type: string }>).map((r) => r.type).sort();
}

async function withVersions(rows: DynastyRow[]): Promise<DynastyResponse[]> {
  if (rows.length === 0) return [];
  const versions = await db
    .select({
      dynastySlug: templateDynastyVersions.dynastySlug,
      type: templateDynastyVersions.promptType,
      position: templateDynastyVersions.position,
      addedAt: templateDynastyVersions.createdAt,
      status: prompts.status,
      statusReason: prompts.statusReason,
      statusChangedBy: prompts.statusChangedBy,
      statusChangedAt: prompts.statusChangedAt,
      copiedFrom: prompts.copiedFrom,
    })
    .from(templateDynastyVersions)
    .innerJoin(prompts, eq(prompts.type, templateDynastyVersions.promptType))
    .where(inArray(templateDynastyVersions.dynastySlug, rows.map((r) => r.slug)))
    .orderBy(asc(templateDynastyVersions.dynastySlug), asc(templateDynastyVersions.position));

  const merged = await db
    .select()
    .from(templateDynasties)
    .where(inArray(templateDynasties.mergedInto, rows.map((r) => r.slug)))
    .orderBy(asc(templateDynasties.mergedAt), asc(templateDynasties.slug));

  return rows.map((row) => {
    const mergedDynasties = merged
      .filter((m) => m.mergedInto === row.slug)
      .map((m): MergedDynasty => ({
        slug: m.slug,
        name: m.name,
        mergedAt: (m.mergedAt ?? m.updatedAt).toISOString(),
        mergedBy: m.mergedBy ?? "",
        reason: m.mergeReason ?? "",
      }));
    const { head, versions: own, status } = applyDynastyStatus(
      versions
        .filter((v) => v.dynastySlug === row.slug)
        .map((v) => ({ type: v.type, position: v.position, addedAt: v.addedAt.toISOString(), copiedFrom: v.copiedFrom, ...servedStatus(v) })),
    );
    return {
      slug: row.slug,
      name: row.name,
      description: row.description,
      signature: row.signature,
      identity: row.identity,
      featureSlug: row.featureSlug,
      legKey: row.legKey,
      ...status,
      head,
      versions: own,
      mergedDynasties,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/** Every dynasty not merged into another, optionally of one pipe (feature slug, leg key, or both), by slug. */
export async function listDynasties(filter: { featureSlug?: string; legKey?: string }): Promise<DynastyResponse[]> {
  const conditions = [isNull(templateDynasties.mergedInto)];
  if (filter.featureSlug) conditions.push(eq(templateDynasties.featureSlug, filter.featureSlug));
  if (filter.legKey) conditions.push(eq(templateDynasties.legKey, filter.legKey));
  const rows = await db
    .select()
    .from(templateDynasties)
    .where(and(...conditions))
    .orderBy(asc(templateDynasties.slug));
  return withVersions(rows);
}

async function readDynastyRow(slug: string): Promise<DynastyRow> {
  const [row] = await db.select().from(templateDynasties).where(eq(templateDynasties.slug, slug));
  if (!row) throw dynastyNotFound(slug);
  return row;
}

/** A dynasty by slug; a merged slug resolves to the dynasty it was merged into (MERGE-TEMPLATE-DYNASTY-1023). */
export async function getDynasty(slug: string): Promise<DynastyResponse> {
  let row = await readDynastyRow(slug);
  for (let hops = 0; row.mergedInto; hops++) {
    if (hops >= 20) throw new Error(`Template dynasty "${slug}" merge chain does not end`);
    row = await readDynastyRow(row.mergedInto);
  }
  const [dynasty] = await withVersions([row]);
  return dynasty;
}

/** The template to write with for a dynasty: its head's stored row. */
export async function resolveDynastyHead(slug: string): Promise<{ dynasty: DynastyResponse; template: PromptRow }> {
  const dynasty = await getDynasty(slug);
  if (!dynasty.head) {
    throw new TemplateDynastyError(409, "DYNASTY_HAS_NO_VERSION", `Template dynasty "${slug}" has no version`);
  }
  const template = await db.query.prompts.findFirst({ where: eq(prompts.type, dynasty.head) });
  if (!template) throw new Error(`Head "${dynasty.head}" of dynasty "${slug}" has no prompts row`);
  return { dynasty, template };
}

/** The stored template (other than `exceptType`) whose text is byte-identical, if any. */
export async function findTemplateTwin(prompt: string, exceptType?: string): Promise<string | null> {
  const [twin] = await db
    .select({ type: prompts.type })
    .from(prompts)
    .where(exceptType ? and(eq(prompts.prompt, prompt), ne(prompts.type, exceptType)) : eq(prompts.prompt, prompt))
    .orderBy(asc(prompts.createdAt))
    .limit(1);
  return twin?.type ?? null;
}

/**
 * Add a version to a dynasty; it becomes the head. Two forms:
 * - `{ prompt, variables }`: a NEW template, stored as the next free `<head family>-vN` (type
 *   families, and whatever reads their prefix, unchanged).
 * - `{ type }`: an ALREADY-STORED template appended as the head (e.g. one stored before its
 *   dynasty existed). Refused if it is already a version of this dynasty.
 * Both refuse: unknown dynasty (404), a text byte-identical to ANY OTHER stored template (409
 * TEMPLATE_TWIN, twin named), a token the head does not declare (400), and the neutrality /
 * blind checks (422) every stored template goes through, judged on what the version adds to the
 * head. The identity check follows the dynasty's identity, not the type prefix: a blind dynasty's
 * text never licenses naming the client, a named one's never hides it (TPL-NAMED-HEAD-1023).
 */
export async function addDynastyVersion(params: {
  slug: string;
  version: { prompt: string; variables: TemplateVariable[] } | { type: string };
  orgId: string | null;
  caller: JudgmentCaller;
  /** Recorded as who deprecated the previous head (reason UPGRADED_REASON). */
  changedBy: string;
}): Promise<{ dynasty: DynastyResponse; template: PromptRow }> {
  const { slug, version, orgId, caller, changedBy } = params;
  const own = await readDynastyRow(slug);
  if (own.mergedInto) throw dynastyMerged(slug, own.mergedInto);
  const { dynasty, template: head } = await resolveDynastyHead(slug);
  const headVariables = (head.variables ?? []) as TemplateVariable[];

  let existing: PromptRow | undefined;
  if ("type" in version) {
    existing = await db.query.prompts.findFirst({ where: eq(prompts.type, version.type) });
    if (!existing) {
      throw new TemplateDynastyError(400, "UNKNOWN_TEMPLATE", `No template of type ${version.type}`, { missing: [version.type] });
    }
    if (dynasty.versions.some((v) => v.type === version.type)) {
      throw new TemplateDynastyError(409, "ALREADY_IN_DYNASTY", `"${version.type}" is already a version of "${slug}"`);
    }
    const [home] = await dynastiesHolding(version.type);
    if (home) throw templateInOtherDynasty(version.type, home.slug);
  }
  const prompt = existing ? existing.prompt : (version as { prompt: string }).prompt;
  const variables = existing
    ? ((existing.variables ?? []) as TemplateVariable[])
    : (version as { variables: TemplateVariable[] }).variables;

  assertVersionVariables(prompt, variables, { type: head.type, variables: headVariables });

  const twin = await findTemplateTwin(prompt, existing?.type);
  if (twin) throw templateTwin(twin);

  const inherited = { prompt: head.prompt, variables: headVariables };
  await assertTemplateNeutral({ prompt, variables, inherited, caller });
  await assertTemplateKeepsDynastyIdentity({
    type: existing?.type ?? head.type,
    prompt,
    variables,
    caller,
    identity: dynasty.identity,
  });

  const newType = existing ? existing.type : await findNextVersionType(head.type);
  const written = await db.transaction(async (tx) => {
    const row = existing ?? (await tx.insert(prompts).values({ orgId, type: newType, prompt, variables }).returning())[0];
    await tx.insert(templateDynastyVersions).values({
      dynastySlug: slug,
      promptType: newType,
      position: sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM template_dynasty_versions WHERE dynasty_slug = ${slug})`,
    });
    await tx.update(templateDynasties).set({ updatedAt: new Date() }).where(eq(templateDynasties.slug, slug));
    const deprecated = await deprecateUpgradedVersions(tx, { changedBy, onlyTypes: [head.type] });
    return { row, deprecated };
  });

  console.log(
    `[template-dynasty] ${slug}: new head ${newType} (was ${head.type})${existing ? " (existing template)" : ""}` +
      (written.deprecated.length ? `; deprecated ${head.type} (${UPGRADED_REASON})` : `; ${head.type} kept (heads another dynasty or already deprecated)`),
  );
  return { dynasty: await getDynasty(slug), template: written.row };
}

/**
 * Merge dynasty `source` INTO dynasty `into` (MERGE-TEMPLATE-DYNASTY-1023, staff). Refused before any write:
 * unknown dynasty (404), itself (400 SAME_DYNASTY), either already merged (409 DYNASTY_MERGED), another pipe
 * (409 DIFFERENT_PIPE), another identity (409 DIFFERENT_IDENTITY). One transaction, both rows locked:
 * - every version of `source` becomes a version of `into`, oldest first at positions 1..n, `into`'s own
 *   versions shifted after them, so `into`'s head (what its workflows write with) is unchanged;
 * - a source version still active is deprecated, reason `Merged into <into>: <reason>`, by `mergedBy`
 *   (an already-deprecated one keeps its stated reason);
 * - `source` is marked merged (who, when, why): it leaves the list and its slug resolves to `into`.
 * No text is judged: no template is created and the head does not move.
 */
export async function mergeDynasty(params: {
  source: string;
  into: string;
  reason: string;
  mergedBy: string;
}): Promise<{ merged: string; movedVersions: string[]; deprecated: string[]; dynasty: DynastyResponse }> {
  const { source, into, reason, mergedBy } = params;
  const result = await db.transaction(async (tx) => {
    // Lock both rows (fixed order) so two merges, or a merge and a new version, never interleave.
    const locked = (await tx.execute(sql`
      SELECT slug, feature_slug AS "featureSlug", leg_key AS "legKey", identity, merged_into AS "mergedInto"
      FROM template_dynasties WHERE slug IN (${source}, ${into}) ORDER BY slug FOR UPDATE`)) as unknown as Array<{
      slug: string; featureSlug: string; legKey: string; identity: string; mergedInto: string | null;
    }>;
    const src = locked.find((r) => r.slug === source);
    const dst = locked.find((r) => r.slug === into);
    if (!src) throw dynastyNotFound(source);
    if (!dst) throw dynastyNotFound(into);
    assertMergeable(src, dst);

    const moved = (await tx.execute(sql`
      SELECT prompt_type AS type FROM template_dynasty_versions WHERE dynasty_slug = ${source} ORDER BY position`)) as unknown as Array<{ type: string }>;
    const n = moved.length;

    const deprecated = n === 0 ? [] : ((await tx.execute(sql`
      UPDATE prompts SET status = 'deprecated', status_reason = ${mergedReason(into, reason)},
        status_changed_by = ${mergedBy}, status_changed_at = now()
      WHERE status = 'active' AND type IN (SELECT prompt_type FROM template_dynasty_versions WHERE dynasty_slug = ${source})
      RETURNING type`)) as unknown as Array<{ type: string }>).map((r) => r.type).sort();

    if (n > 0) {
      // (dynasty_slug, position) is unique and checked per row: park the target's positions below zero,
      // move the source's in at 1..n, then put the target's back after them in their order.
      await tx.execute(sql`UPDATE template_dynasty_versions SET position = -position WHERE dynasty_slug = ${into}`);
      await tx.execute(sql`
        UPDATE template_dynasty_versions v SET dynasty_slug = ${into}, position = r.rn
        FROM (SELECT prompt_type, row_number() OVER (ORDER BY position) AS rn
              FROM template_dynasty_versions WHERE dynasty_slug = ${source}) r
        WHERE v.dynasty_slug = ${source} AND v.prompt_type = r.prompt_type`);
      await tx.execute(sql`
        UPDATE template_dynasty_versions v SET position = ${n} + r.rn
        FROM (SELECT prompt_type, row_number() OVER (ORDER BY position DESC) AS rn
              FROM template_dynasty_versions WHERE dynasty_slug = ${into} AND position < 0) r
        WHERE v.dynasty_slug = ${into} AND v.prompt_type = r.prompt_type`);
    }

    await tx.execute(sql`
      UPDATE template_dynasties SET merged_into = ${into}, merged_at = now(), merged_by = ${mergedBy},
        merge_reason = ${reason}, updated_at = now()
      WHERE slug = ${source}`);
    await tx.execute(sql`UPDATE template_dynasties SET updated_at = now() WHERE slug = ${into}`);
    return { movedVersions: moved.map((m) => m.type), deprecated };
  });

  console.log(
    `[template-dynasty] ${source} merged into ${into} by ${mergedBy}: ${result.movedVersions.length} version(s) moved` +
      (result.deprecated.length ? `, deprecated ${result.deprecated.join(", ")}` : "") + ` (${reason})`,
  );
  return { merged: source, ...result, dynasty: await getDynasty(into) };
}

/** A brand-new template to store as a new dynasty's first (and head) version. */
export interface NewDynastyTemplate {
  /** Defaults to `<dynasty slug>-v1`; later versions take `<family>-vN` from it. */
  type?: string;
  prompt: string;
  variables: TemplateVariable[];
}

/**
 * Create a dynasty, either over existing templates (`versions`, chronological; the last is the
 * head) or from a brand-new text (`template`, stored as its first version and head,
 * TPL-DYNASTY-FROM-TEXT-1021). A new text is refused like every stored template: variables not
 * exactly its tokens (400), a type already taken (409 TEMPLATE_TYPE_TAKEN), a text byte-identical
 * to a stored template (409 TEMPLATE_TWIN), brand/offer neutrality and the dynasty's identity
 * rule (blind or named, 422), judged in full (no head to inherit from) and billed to `caller`.
 * Every refusal happens before anything is written; the template and the dynasty land together.
 */
export async function createDynasty(input: {
  slug: string;
  name: string;
  description: string;
  signature: string;
  identity: DynastyIdentity;
  featureSlug: string;
  legKey: string;
} & (
  | { versions: string[]; template?: undefined }
  | { template: NewDynastyTemplate; versions?: undefined }
), options: { orgId?: string | null; caller?: JudgmentCaller; changedBy?: string } = {}): Promise<DynastyResponse> {
  const { versions: listed, template, ...fields } = input;

  if (listed) {
    const unique = new Set(listed);
    if (unique.size !== listed.length) {
      throw new TemplateDynastyError(400, "DUPLICATE_VERSION", "versions lists a template twice");
    }
    const found = await db.select({ type: prompts.type }).from(prompts).where(inArray(prompts.type, listed));
    const missing = listed.filter((t) => !found.some((f) => f.type === t));
    if (missing.length > 0) {
      throw new TemplateDynastyError(400, "UNKNOWN_TEMPLATE", `No template of type ${missing.join(", ")}`, { missing });
    }
    for (const type of listed) {
      const [home] = await dynastiesHolding(type);
      if (home) throw templateInOtherDynasty(type, home.slug);
    }
    // The head (last listed) is what every workflow on the dynasty writes with: it must keep
    // the dynasty's identity (a blind text headed "Named Free Offer", TPL-NAMED-HEAD-1023).
    if (options.caller) {
      const headType = listed[listed.length - 1];
      const head = await db.query.prompts.findFirst({ where: eq(prompts.type, headType) });
      if (head) {
        await assertTemplateKeepsDynastyIdentity({
          type: head.type,
          prompt: head.prompt,
          variables: (head.variables ?? []) as TemplateVariable[],
          caller: options.caller,
          identity: input.identity,
        });
      }
    }
  }

  const clash = await db
    .select({ slug: templateDynasties.slug, description: templateDynasties.description, name: templateDynasties.name, signature: templateDynasties.signature, featureSlug: templateDynasties.featureSlug, legKey: templateDynasties.legKey })
    .from(templateDynasties);
  for (const c of clash) {
    const samePipe = c.featureSlug === input.featureSlug && c.legKey === input.legKey;
    const field =
      c.slug === input.slug ? "slug"
      : c.description === input.description ? "description"
      : samePipe && c.name === input.name ? "name"
      : samePipe && c.signature === input.signature ? "signature"
      : null;
    if (field) {
      throw new TemplateDynastyError(409, "DYNASTY_CONFLICT", `Dynasty "${c.slug}" already has this ${field}`, { field, dynastySlug: c.slug });
    }
  }

  let newType: string | null = null;
  if (template) {
    if (!options.caller) throw new Error("createDynasty from a new text needs a judgment caller");
    const { prompt, variables } = template;
    newType = template.type ?? `${input.slug}-v1`;
    assertVariablesMatchText(prompt, variables);
    const taken = await db.query.prompts.findFirst({ where: eq(prompts.type, newType), columns: { type: true } });
    if (taken) {
      throw new TemplateDynastyError(409, "TEMPLATE_TYPE_TAKEN", `A template of type "${newType}" is already stored`, { type: newType });
    }
    const twin = await findTemplateTwin(prompt);
    if (twin) throw templateTwin(twin);
    await assertTemplateNeutral({ prompt, variables, caller: options.caller });
    await assertTemplateKeepsDynastyIdentity({
      type: newType, prompt, variables, caller: options.caller, identity: input.identity,
    });
  }

  const versions = listed ?? [newType!];
  await db.transaction(async (tx) => {
    if (template) {
      await tx.insert(prompts).values({
        orgId: options.orgId ?? null, type: newType!, prompt: template.prompt, variables: template.variables,
      });
    }
    await tx.insert(templateDynasties).values(fields);
    await tx.insert(templateDynastyVersions).values(
      versions.map((promptType, i) => ({ dynastySlug: input.slug, promptType, position: i + 1 })),
    );
    // Only the head may be Active: the older versions listed are deprecated "Upgraded".
    const older = versions.slice(0, -1);
    if (older.length > 0) {
      const deprecated = await deprecateUpgradedVersions(tx, { changedBy: options.changedBy ?? UPGRADED_BY_SYSTEM, onlyTypes: older });
      if (deprecated.length) console.log(`[template-dynasty] ${input.slug}: created; deprecated ${deprecated.join(", ")} (${UPGRADED_REASON})`);
    }
  });
  if (template) console.log(`[template-dynasty] ${input.slug}: created from a new text, head ${newType}`);
  return getDynasty(input.slug);
}

export interface DynastyOutput extends TemplateOutput {
  /** The exact version that wrote it. */
  promptType: string;
}

/**
 * The last `limit` generations written with ANY version of a dynasty, newest first, every org
 * (same fields as a template's outputs, plus the version). A version copied from a split shared text
 * also brings what was written under the original name, on both pipes: a generation records no leg.
 */
export async function readDynastyOutputs(slug: string, limit: number): Promise<{ dynasty: DynastyResponse; outputs: DynastyOutput[] }> {
  const dynasty = await getDynasty(slug);
  const types = [...new Set(dynasty.versions.flatMap((v) => (v.copiedFrom ? [v.type, v.copiedFrom] : [v.type])))];
  if (types.length === 0) return { dynasty, outputs: [] };
  const g = emailGenerations;
  const rows = await db
    .select({
      id: g.id,
      createdAt: g.createdAt,
      promptType: g.promptType,
      workflowSlug: g.workflowSlug,
      model: g.model,
      subject: g.subject,
      bodyText: g.bodyText,
      bodyHtml: g.bodyHtml,
      sequence: g.sequence,
    })
    .from(g)
    .where(inArray(g.promptType, types))
    .orderBy(desc(g.createdAt), desc(g.id))
    .limit(limit);
  const emails = rows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    promptType: r.promptType!,
    workflowSlug: r.workflowSlug,
    model: r.model,
    subject: r.subject,
    emails: outputEmails(r),
  }));
  // A WhatsApp dynasty's messages (WA-TEMPLATES-1023) and a Threads dynasty's threads (THREADS-IDEAS-AB); empty for an email dynasty.
  const others = newestFirst(await readWhatsAppOutputs(types, limit), await readThreadOutputs(types, limit), limit);
  return { dynasty, outputs: newestFirst(emails, others, limit) };
}
