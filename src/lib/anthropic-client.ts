import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";

// ─── AI disclaimer ──────────────────────────────────────────────────────────

export const AI_DISCLAIMER_TEXT =
  "Your profile was matched to this opportunity based on publicly available information. This opportunity was summarized for you with AI. If interested or if you have questions, our client will respond directly.";

export const AI_DISCLAIMER_HTML =
  `<p style="font-size:11px;color:#999;font-style:italic;margin-top:24px;">${AI_DISCLAIMER_TEXT}</p>`;

export function appendAiDisclaimer(bodyHtml: string, bodyText: string): { bodyHtml: string; bodyText: string } {
  return {
    bodyHtml: bodyHtml + AI_DISCLAIMER_HTML,
    bodyText: bodyText + "\n\n" + AI_DISCLAIMER_TEXT,
  };
}

// ─── Template generation ────────────────────────────────────────────────────

export interface GenerateFromTemplateParams {
  promptTemplate: string;
  variables: Record<string, unknown>;
  includeAiDisclaimer?: boolean;
  campaignContext?: Record<string, unknown> | null;
}

export interface SequenceStep {
  step: number;
  bodyHtml: string;
  bodyText: string;
  daysSinceLastStep: number;
}

export interface GenerateResult {
  subject: string;
  sequence: SequenceStep[];
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  promptRaw: string;
  responseRaw: object;
}

/**
 * Coerce an unknown value to a string for template substitution.
 * - strings pass through
 * - arrays of strings are comma-joined
 * - everything else is JSON-stringified
 */
export function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join(", ");
  }
  return JSON.stringify(value);
}

/**
 * Substitute {{variable}} placeholders in a prompt template with values.
 * Non-string values are coerced via coerceToString.
 */
export function substituteVariables(
  template: string,
  variables: Record<string, unknown>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, coerceToString(value));
  }
  return result;
}

/**
 * Format campaign featureInputs as a context block prepended to the prompt.
 */
export function formatCampaignContext(featureInputs: Record<string, unknown>): string {
  const lines: string[] = ["## Campaign Context"];
  for (const [key, value] of Object.entries(featureInputs)) {
    if (value == null) continue;
    const label = key.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ").trim();
    lines.push(`- ${label}: ${coerceToString(value)}`);
  }
  return lines.join("\n");
}

/**
 * Find {{placeholder}} names that remain unfilled after variable substitution.
 */
export function findUnfilledPlaceholders(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

// ─── Global system prompt ────────────────────────────────────────────────────
// Applied to every generation call. Contains universal rules that should NOT
// be repeated in individual prompt templates.
const GLOBAL_SYSTEM_PROMPT = [
  "You are generating email content for an automated sending pipeline.",
  "",
  "Universal rules (always apply, regardless of the prompt):",
  "- NEVER include a sign-off, signature, or footer at the end of the email (e.g. '— [Your name]', 'Best, [Name]', 'Regards, …'). The sending service appends the sender's name, title, and organization automatically. Your output must end with the last sentence of the email body — nothing after it.",
  "- NEVER use placeholders like [Your name], [Company], [Insert X], etc. Every piece of text you produce must be ready to send as-is.",
].join("\n");

const EMAIL_SEQUENCE_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    subject: { type: "string" as const },
    emails: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          body: { type: "string" as const },
          daysSinceLastStep: { type: "number" as const },
        },
        required: ["body", "daysSinceLastStep"] as const,
        additionalProperties: false,
      },
    },
  },
  required: ["subject", "emails"] as const,
  additionalProperties: false,
};

/**
 * Generate content by substituting variables into a stored prompt template
 * and sending it to Claude with structured JSON output.
 *
 * The prompt contains all instructions (no hardcoded system prompt).
 * Output is always a variable-length email sequence.
 */
export async function generateFromTemplate(
  apiKey: string,
  params: GenerateFromTemplateParams
): Promise<GenerateResult> {
  const anthropic = new Anthropic({ apiKey });

  let prompt = substituteVariables(params.promptTemplate, params.variables);

  // Convention 2: inject campaign featureInputs as additional context
  if (params.campaignContext && Object.keys(params.campaignContext).length > 0) {
    const contextBlock = formatCampaignContext(params.campaignContext);
    prompt = `${contextBlock}\n\n${prompt}`;
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3072,
    system: GLOBAL_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: EMAIL_SEQUENCE_JSON_SCHEMA,
      },
    },
  });

  const textContent = response.content.find((c) => c.type === "text");
  const text = textContent?.type === "text" ? textContent.text : "";

  let parsed = parseSequenceJson(text);

  if (params.includeAiDisclaimer) {
    parsed = {
      subject: parsed.subject,
      sequence: parsed.sequence.map((step) => {
        const patched = appendAiDisclaimer(step.bodyHtml, step.bodyText);
        return { ...step, ...patched };
      }),
    };
  }

  const tokensInput = response.usage.input_tokens;
  const tokensOutput = response.usage.output_tokens;
  const costUsd =
    (tokensInput / 1_000_000) * 3 +
    (tokensOutput / 1_000_000) * 15;

  return {
    ...parsed,
    tokensInput,
    tokensOutput,
    costUsd,
    promptRaw: prompt,
    responseRaw: response,
  };
}

function textToHtml(text: string): string {
  return text
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function parseSequenceJson(text: string): {
  subject: string;
  sequence: SequenceStep[];
} {
  const json = JSON.parse(text) as {
    subject: string;
    emails: Array<{ body: string; daysSinceLastStep: number }>;
  };

  const sequence: SequenceStep[] = json.emails.map((email, i) => {
    const bodyText = email.body.trim();
    return {
      step: i + 1,
      bodyHtml: textToHtml(bodyText),
      bodyText,
      daysSinceLastStep: email.daysSinceLastStep,
    };
  });

  return { subject: json.subject, sequence };
}
