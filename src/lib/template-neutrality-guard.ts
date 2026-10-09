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
  splitTemplatePassages,
  templateNeutralityKey,
  type JudgedPassage,
  type NeutralityVerdict,
  type TemplateVariable,
} from "./template-neutrality.js";

async function judgeTemplate(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>,
  caller: JudgmentCaller,
): Promise<{ verdict: NeutralityVerdict; model: string; inputTokens: number }> {
  const passages = splitTemplatePassages(prompt, variables);
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
 */
export async function assertTemplateNeutral(params: {
  prompt: string;
  variables: ReadonlyArray<TemplateVariable>;
  caller: JudgmentCaller;
}): Promise<void> {
  const { prompt, variables, caller } = params;
  const contentKey = templateNeutralityKey(prompt, variables);

  const stored = await db.query.templateNeutralityJudgments.findFirst({
    where: eq(templateNeutralityJudgments.contentKey, contentKey),
  });

  let specific: JudgedPassage[];
  if (stored) {
    specific = (stored.passages as JudgedPassage[]).filter(
      (p) => p.probability >= SPECIFIC_PROBABILITY_THRESHOLD,
    );
  } else {
    const { verdict, model, inputTokens } = await judgeTemplate(prompt, variables, caller);
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
}
