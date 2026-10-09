// Brand/offer neutrality of a SHARED prompt template — the pure half.
//
// Every row of `prompts` is global by `type`: any org's workflow can render any
// type, and the dashboard Copilot creates and forks templates live from one
// client's conversation. A template whose FIXED text names that client (its
// brand, its offer, a price, a result figure, a person) would put a stranger's
// facts into every other brand's emails the moment it is reused. So every write
// that stores a template is judged first, passage by passage, and refused when a
// passage is specific — the fix is to turn that passage into a {{variable}}.
//
// This module is standalone (no db, no fetch; it imports only the JudgmentsError class): it splits a template into
// passages, builds the Jev questions, and reads the answers into a verdict. The
// I/O half (chat-service call + persisted verdict) is template-neutrality-guard.ts.

import { createHash } from "node:crypto";
import { JudgmentsError } from "./judgments-client.js";

/**
 * Bump when the question wording, the splitting or the threshold changes: it is
 * part of the persisted verdict key, so a new rule re-judges instead of serving
 * a verdict reached under the old one.
 */
export const TEMPLATE_NEUTRALITY_VERSION = "2";

/** A passage is refused at or above this yes-probability. */
export const SPECIFIC_PROBABILITY_THRESHOLD = 0.5;

/**
 * Questions per chat-service call. The template rides as the judgment's `state`
 * (read once per call) and each passage is one question; 50 keeps the largest
 * stored template (~10.6k chars, 212 lines) inside the vendor's 64k-token budget.
 */
export const QUESTIONS_PER_CALL = 50;

export interface TemplatePassage {
  /** The passage text, verbatim as written (tokens included). */
  text: string;
  /** Where it lives: `prompt`, or `variables.<name>` for a variable description. */
  location: string;
}

export interface JudgedPassage extends TemplatePassage {
  /** Jev's probability that the passage is specific to one company/offer/person. */
  probability: number;
}

export interface NeutralityVerdict {
  neutral: boolean;
  /** Every passage judged, specific or not (persisted for audit). */
  passages: JudgedPassage[];
  /** The passages that made the template refused. Empty when neutral. */
  specific: JudgedPassage[];
}

export interface TemplateVariable {
  name: string;
  description: string;
}

const TOKEN_RE = /\{\{\w+\}\}/g;

/** True when the passage has words of its own once its {{tokens}} are removed. */
function hasFixedWords(text: string): boolean {
  const fixed = text.replace(TOKEN_RE, " ");
  return /\p{L}{2,}/u.test(fixed);
}

/** Leading markdown structure ("## ", "- ", "1. ", "> ") carries no meaning to judge. */
function stripMarkdownLead(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)*/, "").trim();
}

/**
 * Split a template into the passages that are judged: each line, then each
 * sentence of a line. Passages with no fixed words (blank lines, a lone token,
 * punctuation) are skipped; duplicates are judged once. Variable descriptions are
 * passages too: they are stored and shared exactly like the body.
 */
export function splitTemplatePassages(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>,
): TemplatePassage[] {
  const out: TemplatePassage[] = [];
  const seen = new Set<string>();
  const push = (text: string, location: string) => {
    const t = text.trim();
    if (!t || !hasFixedWords(t)) return;
    const key = `${location}\u0000${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, location });
  };

  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = stripMarkdownLead(rawLine);
    if (!line) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) push(sentence, "prompt");
  }
  for (const v of variables) push(v.description, `variables.${v.name}`);
  return out;
}

/** sha256 over everything that shapes the verdict: rule version, body, variables. */
export function templateNeutralityKey(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>,
): string {
  return createHash("sha256")
    .update(JSON.stringify([TEMPLATE_NEUTRALITY_VERSION, prompt, variables]))
    .digest("hex");
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

const CRITERIA = {
  true:
    "Yes: the fixed text carries a specific identity or fact, e.g. a company, brand or product name ('Acme', 'Notion'), a concrete offer ('our free 14-day SEO audit'), a price ('$99/month'), a claimed result or figure about a business ('we helped 300 dentists', 'cut churn by 32%'), a customer name, or a named person ('Sarah, our CEO').",
  false:
    "No: it is a generic writing instruction, structure, tone, length or formatting rule that fits any company. Generic roles ('the client', 'the prospect', 'the brand'), word counts and step counts are generic. A specific detail that sits only inside a {{variable}} is fine, because each company fills the variable with its own data. Naming the channel, platform or tool the content is written for or published on ('LinkedIn', 'Featured.com', 'Gmail', 'X') is also fine: that is the same for every company using the template, not one company's identity.",
};

export function buildNeutralityQuestion(passage: TemplatePassage): NoulQuestion {
  const where =
    passage.location === "prompt"
      ? "one passage of the template's fixed text"
      : `the description of the template variable "${passage.location.slice("variables.".length)}"`;
  return {
    type: "noul",
    instructions: [
      "A writing template will be reused, word for word, by many unrelated companies to write their own emails and posts. Text inside {{double braces}} is a variable that each company fills with its own data.",
      `Below is ${where}.`,
      "",
      `Passage: """${passage.text}"""`,
      "",
      "Does this passage's fixed text name or describe ONE particular company, brand, product, offer, price, result figure, customer or person, so that it would be false or out of place in another company's email? The channel or platform the content is written for does not count.",
    ].join("\n"),
    criteria: CRITERIA,
  };
}

/** Questions keyed `p<index>` so an answer maps back to its passage. */
export function buildNeutralityQuestions(
  passages: ReadonlyArray<TemplatePassage>,
  offset: number,
): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  passages.forEach((p, i) => {
    questions[`p${offset + i}`] = buildNeutralityQuestion(p);
  });
  return questions;
}

/**
 * Read Jev's answers into a verdict. Fail loud on an answer that is missing or
 * not a noul: a passage nobody judged must never read as neutral.
 */
export function interpretNeutralityAnswers(
  passages: ReadonlyArray<TemplatePassage>,
  answers: Record<string, unknown>,
): NeutralityVerdict {
  const judged: JudgedPassage[] = passages.map((p, i) => {
    const a = answers[`p${i}`] as { type?: string; noul?: unknown } | undefined;
    if (!a || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) {
      throw new Error(
        `[template-neutrality] judgment answer p${i} missing or not a noul: ${JSON.stringify(a)}`,
      );
    }
    return { ...p, probability: a.noul };
  });
  const specific = judged.filter((p) => p.probability >= SPECIFIC_PROBABILITY_THRESHOLD);
  return { neutral: specific.length === 0, passages: judged, specific };
}

/** Refusal raised before a non-neutral template is stored. Route answers 422. */
export class TemplateNotNeutralError extends Error {
  readonly status = 422;
  readonly code = "TEMPLATE_NOT_NEUTRAL";
  readonly passages: JudgedPassage[];

  constructor(specific: JudgedPassage[]) {
    super(
      `Template is not brand/offer neutral: ${specific.length} passage(s) name or describe a specific company, offer, figure or person. ` +
        "Templates are shared by every brand. Replace the specific part of each cited passage with a {{variable}} declared in `variables` (e.g. {{brandName}}, {{offerName}}), or rewrite it generically, then resubmit.",
    );
    this.name = "TemplateNotNeutralError";
    this.passages = specific;
  }

  toResponseBody() {
    return {
      error: this.message,
      code: this.code,
      passages: this.passages.map((p) => ({
        passage: p.text,
        location: p.location,
        probability: p.probability,
      })),
    };
  }
}

/**
 * The HTTP answer for a failed template write. A refusal is 422 with the cited
 * passages; a chat-service failure keeps its 402 (credits) / 429 (vendor rate
 * limit, retryable) and is otherwise 502. Nothing is stored in any of these cases.
 * Returns null for any other error, which the route handles as before.
 */
export function templateWriteErrorResponse(
  error: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (error instanceof TemplateNotNeutralError) {
    return { status: 422, body: error.toResponseBody() };
  }
  if (error instanceof JudgmentsError) {
    const status = error.status === 402 || error.status === 429 ? error.status : 502;
    return {
      status,
      body: {
        error: `Template neutrality check unavailable, template not stored: ${error.message}`,
        code: "TEMPLATE_NEUTRALITY_CHECK_FAILED",
      },
    };
  }
  return null;
}
