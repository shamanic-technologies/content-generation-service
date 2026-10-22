// Brand/offer neutrality of a SHARED prompt template — the I/O half.
// Rules and wording: template-neutrality.ts. Called by every route that STORES a
// template (POST /prompts, POST /platform-prompts, PUT /prompts, PUT
// /prompt-assignments) right before the insert; the boot reconcile of code-owned
// platform templates is not a write from a conversation and is not judged.

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { templateNeutralityJudgments } from "../db/schema.js";
import { askJudgments, type JudgmentCaller } from "./judgments-client.js";
import {
  QUESTIONS_PER_CALL,
  SPECIFIC_PROBABILITY_THRESHOLD,
  TEMPLATE_NEUTRALITY_VERSION,
  TemplateNotNeutralError,
  buildNeutralityQuestions,
  interpretNeutralityAnswers,
  passagesToJudge,
  templateNeutralityKey,
  type InheritedTemplate,
  type JudgedPassage,
  type NeutralityVerdict,
  type TemplatePassage,
  type TemplateVariable,
} from "./template-neutrality.js";
import {
  BLIND_TEMPLATE_RULE_VERSION,
  BlindTemplateRevealsClientError,
  blindPassagesToJudge,
  blindTemplateRuleKey,
  buildBlindRuleQuestions,
  isBlindTemplateType,
} from "./blind-template-rule.js";
import {
  NAMED_TEMPLATE_RULE_VERSION,
  NamedTemplateHidesClientError,
  buildNamedRuleQuestions,
  namedPassagesToJudge,
  namedTemplateRuleKey,
} from "./named-template-rule.js";

async function judgeTemplate(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>,
  inherited: InheritedTemplate | undefined,
  caller: JudgmentCaller,
): Promise<{ verdict: NeutralityVerdict; model: string; inputTokens: number }> {
  // The whole template stays the judgment's state (context); only the passages
  // this write adds are questions.
  const passages = passagesToJudge(prompt, variables, inherited);
  const answers: Record<string, unknown> = {};
  let model = "none";
  let inputTokens = 0;
  for (let offset = 0; offset < passages.length; offset += QUESTIONS_PER_CALL) {
    const chunk = passages.slice(offset, offset + QUESTIONS_PER_CALL);
    const res = await askJudgments(
      { state: prompt, questions: buildNeutralityQuestions(chunk, offset) },
      caller,
    );
    Object.assign(answers, res.answers);
    model = res.model;
    inputTokens += res.usage.inputTokens;
  }
  return { verdict: interpretNeutralityAnswers(passages, answers), model, inputTokens };
}

/**
 * Throws TemplateNotNeutralError (→ 422) when a passage of the template is
 * specific to one company/offer/person. Judged once per distinct content: the
 * verdict is persisted and a resubmission of the same content reads it back.
 * A chat-service failure propagates (JudgmentsError) — nothing is stored unjudged.
 * `inherited` = the template a new version derives from: its unchanged passages
 * are not judged, so an edit is refused only for text it adds.
 */
export async function assertTemplateNeutral(params: {
  prompt: string;
  variables: ReadonlyArray<TemplateVariable>;
  inherited?: InheritedTemplate;
  caller: JudgmentCaller;
  /** The type stored (or its family): a blind type is also judged by the blind rule, below. */
  type?: string;
}): Promise<void> {
  const { prompt, variables, inherited, caller } = params;
  const contentKey = templateNeutralityKey(prompt, variables, inherited);

  const stored = await db.query.templateNeutralityJudgments.findFirst({
    where: eq(templateNeutralityJudgments.contentKey, contentKey),
  });

  let specific: JudgedPassage[];
  if (stored) {
    specific = (stored.passages as JudgedPassage[]).filter(
      (p) => p.probability >= SPECIFIC_PROBABILITY_THRESHOLD,
    );
  } else {
    const { verdict, model, inputTokens } = await judgeTemplate(prompt, variables, inherited, caller);
    await db
      .insert(templateNeutralityJudgments)
      .values({
        contentKey,
        ruleVersion: TEMPLATE_NEUTRALITY_VERSION,
        neutral: verdict.neutral,
        passages: verdict.passages,
        model,
        inputTokens,
        orgId: caller.mode === "org" ? caller.tracking.orgId : null,
        runId: caller.mode === "org" ? caller.tracking.runId : null,
      })
      .onConflictDoNothing();
    specific = verdict.specific;
  }

  if (specific.length > 0) {
    console.warn(
      `[template-neutrality] refused template key=${contentKey.slice(0, 12)} specific=${specific.length} cached=${Boolean(stored)}`,
    );
    throw new TemplateNotNeutralError(specific);
  }

  if (params.type) {
    await assertBlindTemplateKeepsClientAnonymous({ type: params.type, prompt, variables, caller });
  }
}

/**
 * Judge EVERY passage of a template with one identity rule (blind or named), persisted under
 * the rule's own key so a resubmission of the same content costs nothing. Returns the
 * passages at or above the refusal threshold (empty = the template keeps its identity).
 */
async function judgeIdentityRule(rule: {
  name: string;
  version: string;
  contentKey: string;
  passages: () => TemplatePassage[];
  questions: (chunk: TemplatePassage[], offset: number) => Record<string, unknown>;
  type: string;
  prompt: string;
  caller: JudgmentCaller;
}): Promise<JudgedPassage[]> {
  const { contentKey, prompt, caller } = rule;
  const stored = await db.query.templateNeutralityJudgments.findFirst({
    where: eq(templateNeutralityJudgments.contentKey, contentKey),
  });

  let refused: JudgedPassage[];
  if (stored) {
    refused = (stored.passages as JudgedPassage[]).filter(
      (p) => p.probability >= SPECIFIC_PROBABILITY_THRESHOLD,
    );
  } else {
    const passages = rule.passages();
    const answers: Record<string, unknown> = {};
    let model = "none";
    let inputTokens = 0;
    for (let offset = 0; offset < passages.length; offset += QUESTIONS_PER_CALL) {
      const chunk = passages.slice(offset, offset + QUESTIONS_PER_CALL);
      const res = await askJudgments({ state: prompt, questions: rule.questions(chunk, offset) }, caller);
      Object.assign(answers, res.answers);
      model = res.model;
      inputTokens += res.usage.inputTokens;
    }
    // Same reading as neutrality: a missing answer fails loud, >= 0.5 is refused.
    const verdict = interpretNeutralityAnswers(passages, answers);
    await db
      .insert(templateNeutralityJudgments)
      .values({
        contentKey,
        ruleVersion: rule.version,
        neutral: verdict.neutral,
        passages: verdict.passages,
        model,
        inputTokens,
        orgId: caller.mode === "org" ? caller.tracking.orgId : null,
        runId: caller.mode === "org" ? caller.tracking.runId : null,
      })
      .onConflictDoNothing();
    refused = verdict.specific;
  }

  if (refused.length > 0) {
    console.warn(
      `[${rule.name}] refused type=${rule.type} key=${contentKey.slice(0, 12)} passages=${refused.length} cached=${Boolean(stored)}`,
    );
  }
  return refused;
}

/**
 * Throws BlindTemplateRevealsClientError (→ 422) when a BLIND-type template tells or
 * allows the writer to name the client, its website or a link to it (blind-template-rule.ts).
 * Any other type returns at once. Every passage is judged, inherited ones included;
 * the verdict is persisted beside the neutrality verdicts under its own key, so a
 * resubmission of the same content costs nothing.
 */
export async function assertBlindTemplateKeepsClientAnonymous(params: {
  type: string;
  prompt: string;
  variables: ReadonlyArray<TemplateVariable>;
  caller: JudgmentCaller;
  /**
   * Whether the template is blind. Default: read from the type prefix. A dynasty version
   * passes its dynasty's identity instead: the identity is the truth, some historical
   * type names say otherwise (template-dynasties.ts).
   */
  blind?: boolean;
}): Promise<void> {
  const { type, prompt, variables, caller } = params;
  if (!(params.blind ?? isBlindTemplateType(type))) return;
  const licensing = await judgeIdentityRule({
    name: "blind-template-rule",
    version: BLIND_TEMPLATE_RULE_VERSION,
    contentKey: blindTemplateRuleKey(prompt, variables),
    passages: () => blindPassagesToJudge(prompt, variables),
    questions: buildBlindRuleQuestions,
    type,
    prompt,
    caller,
  });
  if (licensing.length > 0) throw new BlindTemplateRevealsClientError(type, licensing);
}

/**
 * Throws NamedTemplateHidesClientError (→ 422) when a template of a NAMED dynasty tells the
 * writer to keep the client anonymous (named-template-rule.ts). Every passage is judged,
 * inherited ones included; verdict persisted under its own key.
 */
export async function assertNamedTemplateNamesClient(params: {
  type: string;
  prompt: string;
  variables: ReadonlyArray<TemplateVariable>;
  caller: JudgmentCaller;
}): Promise<void> {
  const { type, prompt, variables, caller } = params;
  const hiding = await judgeIdentityRule({
    name: "named-template-rule",
    version: NAMED_TEMPLATE_RULE_VERSION,
    contentKey: namedTemplateRuleKey(prompt, variables),
    passages: () => namedPassagesToJudge(prompt, variables),
    questions: buildNamedRuleQuestions,
    type,
    prompt,
    caller,
  });
  if (hiding.length > 0) throw new NamedTemplateHidesClientError(type, hiding);
}

/**
 * A dynasty's text must keep its dynasty's identity (owner 2026-10-23: binary, blind | named):
 * a blind dynasty's text never licenses naming the client, a named one's never hides it.
 */
export async function assertTemplateKeepsDynastyIdentity(params: {
  type: string;
  prompt: string;
  variables: ReadonlyArray<TemplateVariable>;
  caller: JudgmentCaller;
  identity: "blind" | "named";
}): Promise<void> {
  const { identity, ...rest } = params;
  if (identity === "blind") await assertBlindTemplateKeepsClientAnonymous({ ...rest, blind: true });
  else await assertNamedTemplateNamesClient(rest);
}
