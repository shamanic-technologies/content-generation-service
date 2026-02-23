import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";

function buildSystemPrompt(): string {
  const now = new Date().toISOString().split("T")[0];
  return `Today is ${now}.

You're writing a 3-email cold outreach sequence on behalf of a sales rep. Your job is to get a reply — nothing else matters.

## Output rule
Always respond with the 3 emails ready to send. Never respond with commentary, suggestions, analysis, or a discussion — only the emails themselves.

## Sequence structure
- **Email 1 (body):** The initial cold email. Lead with a contrarian angle.
- **Email 2 (followup1):** A short follow-up sent ~3 days after email 1. Reference the first email without repeating it. Keep it to 2-3 sentences. Same thread — no new subject line.
- **Email 3 (followup2):** A final follow-up sent ~7 days after email 2. Take a different angle. This is the last attempt — make it count. Same thread — no new subject line.

## Keep it simple
Write like a human texting a smart friend. Short sentences. Plain words. If a sentence needs to be read twice to be understood, it's too complicated. The contrarian angle should hit instantly — not require a PhD to parse.

## Tone
Greet the recipient by first name — it's a real email from a real person, not a blog post. Keep it warm, direct, conversational.

## Identity protection
Keep the client anonymous. Say "a client of mine", "a company I work with", etc. Don't include their website URL. Curiosity is the goal — the recipient should want to reply to learn more.

## Opening line (Email 1 only)
Don't open with a compliment. "Your work in X caught my attention" is the fastest way to get deleted — it screams template. Instead, lead with a contrarian angle: a simple, provocative observation that challenges something people in the recipient's world take for granted, and that connects to why the client's offering exists. The best opening feels like an insight from a peer, not a pitch from a stranger.

## Scam filter
Cold emails live or die on trust. Avoid anything that pattern-matches to scam or MLM: specific dollar amounts, crypto terminology (tokens, chains, USDT, Web3), compensation details, "passive income" language. Lead with the mission and the human impact. The money conversation happens later, on a call, once trust is established.`;
}

// ─── AI disclaimer ──────────────────────────────────────────────────────────

export const AI_DISCLAIMER_TEXT =
  "This message was sent because your profile matched an opportunity. It was drafted with the help of AI. If you reply, a real person will get back to you directly.";

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
  aiDisclaimer?: boolean;
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

const EMAIL_SEQUENCE_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    subject: { type: "string" as const },
    body: { type: "string" as const },
    followup1: { type: "string" as const },
    followup2: { type: "string" as const },
  },
  required: ["subject", "body", "followup1", "followup2"],
  additionalProperties: false,
};

/**
 * Generate content by substituting variables into a stored prompt template
 * and sending it to Claude with structured JSON output.
 */
export async function generateFromTemplate(
  apiKey: string,
  params: GenerateFromTemplateParams
): Promise<GenerateResult> {
  const anthropic = new Anthropic({ apiKey });

  const prompt = substituteVariables(params.promptTemplate, params.variables);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3072,
    system: buildSystemPrompt(),
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

  if (params.aiDisclaimer) {
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
    body: string;
    followup1: string;
    followup2: string;
  };

  const bodies = [
    { raw: json.body, daysSinceLastStep: 0 },
    { raw: json.followup1, daysSinceLastStep: 3 },
    { raw: json.followup2, daysSinceLastStep: 7 },
  ];

  const sequence: SequenceStep[] = bodies.map((b, i) => {
    const bodyText = b.raw.trim();
    return {
      step: i + 1,
      bodyHtml: textToHtml(bodyText),
      bodyText,
      daysSinceLastStep: b.daysSinceLastStep,
    };
  });

  return { subject: json.subject, sequence };
}
