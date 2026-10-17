// A blind-type template may not tell the writer to reveal the client — the pure half
// (BLIND-WRITER-1017). The I/O half (Jev call + persisted verdict) is
// template-neutrality-guard.ts, run at the same writes as the neutrality check.
//
// The templates in use contradicted their own type: "never reveal the client name or
// URL" next to "the client name if recognizable" in the subject, the URL "lightly" in
// the body, "you can name the agency now". The template text is the only guarantee
// (no per-email check at run time: owner 2026-10-17, no extra spend, some noise
// accepted), so this check stops a new blind-type template from being STORED with a
// passage that licenses naming the client: one judgment per new template, never per email.
//
// Every passage is judged, inherited ones included: unlike neutrality, a licensing
// passage carried over from an older version is exactly the defect to remove, so an
// upgrade of `blind-discovery-email-v34` is accepted only once those passages are gone.
// Wording measured 2026-10-17 on prod templates: v34/v36 refused on their 4 licensing
// passages (0.82 to 0.94), v16 on its URL/name section (0.85 to 0.98), v26 on its
// destination-URL rule (0.75); v15 and feedback-request-blind-email-v1 (which forbid it)
// pass at ≤ 0.12.

import { createHash } from "node:crypto";
import {
  splitTemplatePassages,
  type JudgedPassage,
  type NoulQuestion,
  type TemplatePassage,
  type TemplateVariable,
} from "./template-neutrality.js";

/** Part of the persisted verdict key: bump when the wording, splitting or threshold changes. */
export const BLIND_TEMPLATE_RULE_VERSION = "blind-1";

/**
 * A template TYPE starting with one of these promises the prospect never learns who the
 * client is from the email (features-service tags "Blind angle" on the type alone).
 */
export const BLIND_TEMPLATE_TYPE_PREFIXES = ["blind-discovery-email", "feedback-request-blind-email"] as const;

/** True for every version of a blind-type template (`blind-discovery-email-v34`, `-v9-landing-v3`, ...). */
export function isBlindTemplateType(type: string): boolean {
  return BLIND_TEMPLATE_TYPE_PREFIXES.some((p) => type === p || type.startsWith(`${p}-`));
}

/** Every passage of the template and of its variable descriptions. */
export function blindPassagesToJudge(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>
): TemplatePassage[] {
  return splitTemplatePassages(prompt, variables);
}

export function blindTemplateRuleKey(prompt: string, variables: ReadonlyArray<TemplateVariable>): string {
  return createHash("sha256").update(JSON.stringify([BLIND_TEMPLATE_RULE_VERSION, prompt, variables])).digest("hex");
}

const CRITERIA = {
  true:
    "Yes: it asks for or permits revealing the client in the email, e.g. 'use the client name if recognizable', 'mention the website lightly: full information: [url]', 'drop the client's URL once at the end of email 1', 'you can name the agency now', 'include the brand's destination URL'.",
  false:
    "No: it says nothing about revealing the client, or it forbids it ('never name the client or its URL', 'internal only, never reveal'), or it is about the PROSPECT's own company or name, the names of the client's customers used as proof, a person's role, or a generic writing, tone or structure rule.",
};

export function buildBlindRuleQuestion(passage: TemplatePassage): NoulQuestion {
  const where =
    passage.location === "prompt"
      ? "one passage of the template"
      : `the description of the template variable "${passage.location.slice("variables.".length)}"`;
  return {
    type: "noul",
    instructions: [
      "A writing template tells an AI how to write cold emails on behalf of a client company to a prospect who has never heard of that client. In these emails the client stays ANONYMOUS: the prospect must not learn the client's name, brand, website, domain or URL from the email. Text inside {{double braces}} is a variable each company fills with its own data.",
      `Below is ${where}.`,
      "",
      `Passage: """${passage.text}"""`,
      "",
      "Does this passage tell, invite or allow the writer to put the client's name, brand name, website, domain, URL or a link to the client in the email (subject line or any email body)?",
    ].join("\n"),
    criteria: CRITERIA,
  };
}

export function buildBlindRuleQuestions(
  passages: ReadonlyArray<TemplatePassage>,
  offset: number
): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  passages.forEach((p, i) => {
    questions[`p${offset + i}`] = buildBlindRuleQuestion(p);
  });
  return questions;
}

/** Refusal raised before a blind-type template that licenses naming the client is stored. Route answers 422. */
export class BlindTemplateRevealsClientError extends Error {
  readonly status = 422;
  readonly code = "BLIND_TEMPLATE_REVEALS_CLIENT";
  readonly passages: JudgedPassage[];

  constructor(type: string, licensing: JudgedPassage[]) {
    super(
      `Template type "${type}" is a blind template: its emails never name the client. ${licensing.length} passage(s) tell or allow the writer to put the client's name, website or a link to them in the email. ` +
        "Delete those passages (or reword them to keep the client anonymous), then resubmit.",
    );
    this.name = "BlindTemplateRevealsClientError";
    this.passages = licensing;
  }

  toResponseBody() {
    return {
      error: this.message,
      code: this.code,
      passages: this.passages.map((p) => ({ passage: p.text, location: p.location, probability: p.probability })),
    };
  }
}
