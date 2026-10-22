// A NAMED dynasty's template may not tell the writer to hide the client: the pure half
// (TPL-NAMED-HEAD-1023). The mirror of blind-template-rule.ts; the I/O half (Jev call +
// persisted verdict) is template-neutrality-guard.ts, run at every dynasty write.
//
// A dynasty's identity is binary (owner 2026-10-23): `named` emails name the client,
// `blind` ones never do. "Named Free Offer" (cold-click-free-offer-named) was seeded with
// `blind-discovery-email-website-visit-v34` as its head, a blind text ("Brand Intelligence
// (internal only: never reveal the client name or URL)"), so features-service could not
// tell which angle it played (named 0.21) and no "Named only" strategy ever picked it.
// Nothing checked a named dynasty's text; this does, once per new version, never per email.
//
// Every passage is judged, inherited ones included (like the blind rule): a hiding passage
// carried over from the head is exactly the defect to remove.

import { createHash } from "node:crypto";
import {
  splitTemplatePassages,
  type JudgedPassage,
  type NoulQuestion,
  type TemplatePassage,
  type TemplateVariable,
} from "./template-neutrality.js";

/** Part of the persisted verdict key: bump when the wording, splitting or threshold changes. */
export const NAMED_TEMPLATE_RULE_VERSION = "named-1";

/** Every passage of the template and of its variable descriptions. */
export function namedPassagesToJudge(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>
): TemplatePassage[] {
  return splitTemplatePassages(prompt, variables);
}

export function namedTemplateRuleKey(prompt: string, variables: ReadonlyArray<TemplateVariable>): string {
  return createHash("sha256").update(JSON.stringify([NAMED_TEMPLATE_RULE_VERSION, prompt, variables])).digest("hex");
}

const CRITERIA = {
  true:
    "Yes: it asks the writer to keep the client anonymous or hidden, e.g. 'never reveal the client name or URL', 'internal only: never write this name', 'refer to them as the team I work with', 'never name the client, its brand or its website', 'this sequence is anonymous'.",
  false:
    "No: it names the client or allows it, or says nothing about revealing the client, or it is about leaving out LINKS only, the PROSPECT's own company or name, the names of the client's customers used as proof, a person's role, or a generic writing, tone or structure rule.",
};

export function buildNamedRuleQuestion(passage: TemplatePassage): NoulQuestion {
  const where =
    passage.location === "prompt"
      ? "one passage of the template"
      : `the description of the template variable "${passage.location.slice("variables.".length)}"`;
  return {
    type: "noul",
    instructions: [
      "A writing template tells an AI how to write cold emails on behalf of a client company to a prospect who has never heard of that client. In these emails the client is NAMED: the prospect learns from the email who the client is. Text inside {{double braces}} is a variable each company fills with its own data.",
      `Below is ${where}.`,
      "",
      `Passage: """${passage.text}"""`,
      "",
      "Does this passage tell the writer to keep the client anonymous, that is to never write the client's name or brand name in the email, or to hide who the client is from the prospect?",
    ].join("\n"),
    criteria: CRITERIA,
  };
}

export function buildNamedRuleQuestions(
  passages: ReadonlyArray<TemplatePassage>,
  offset: number
): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  passages.forEach((p, i) => {
    questions[`p${offset + i}`] = buildNamedRuleQuestion(p);
  });
  return questions;
}

/** Refusal raised before a named dynasty stores a version that hides the client. Route answers 422. */
export class NamedTemplateHidesClientError extends Error {
  readonly status = 422;
  readonly code = "NAMED_TEMPLATE_HIDES_CLIENT";
  readonly passages: JudgedPassage[];

  constructor(type: string, hiding: JudgedPassage[]) {
    super(
      `Template "${type}" is for a named dynasty: its emails name the client. ${hiding.length} passage(s) tell the writer to keep the client anonymous. ` +
        "Delete those passages (or reword them so the email names the client), then resubmit.",
    );
    this.name = "NamedTemplateHidesClientError";
    this.passages = hiding;
  }

  toResponseBody() {
    return {
      error: this.message,
      code: this.code,
      passages: this.passages.map((p) => ({ passage: p.text, location: p.location, probability: p.probability })),
    };
  }
}
