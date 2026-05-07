const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || "";

// ─── Template generation ────────────────────────────────────────────────────

export interface ChatServiceIdentity {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface GenerateFromTemplateParams {
  promptTemplate: string;
  variables: Record<string, unknown>;
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
  model: string;
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
  "",
  "You must respond with a JSON object matching this exact schema:",
  '{"subject": "<email subject line>", "emails": [{"body": "<plain text email body>", "daysSinceLastStep": <number>}]}',
  "- subject: the email subject line (string)",
  "- emails: array of email steps. Each has:",
  "  - body: plain text email body (string)",
  "  - daysSinceLastStep: days to wait since the previous email, 0 for the first (number)",
  "Return ONLY the JSON object, no additional text or markdown.",
].join("\n");

// ─── Insufficient credits error ─────────────────────────────────────────────

export class InsufficientCreditsError extends Error {
  status = 402;
  balance_cents: number;
  required_cents: number;

  constructor(balance_cents: number, required_cents: number) {
    super("Insufficient credits");
    this.balance_cents = balance_cents;
    this.required_cents = required_cents;
  }
}

// ─── Chat-service response type ─────────────────────────────────────────────

interface ChatCompleteResponse {
  content: string;
  json: { subject: string; emails: Array<{ body: string; daysSinceLastStep: number }> };
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

/**
 * Generate content by substituting variables into a stored prompt template
 * and sending it to chat-service for LLM completion.
 *
 * Chat-service handles key resolution, billing, and cost tracking internally.
 * Output is always a variable-length email sequence.
 */
export async function generateFromTemplate(
  params: GenerateFromTemplateParams,
  identity: ChatServiceIdentity
): Promise<GenerateResult> {
  let prompt = substituteVariables(params.promptTemplate, params.variables);

  // Inject campaign featureInputs as additional context
  if (params.campaignContext && Object.keys(params.campaignContext).length > 0) {
    const contextBlock = formatCampaignContext(params.campaignContext);
    prompt = `${contextBlock}\n\n${prompt}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": CHAT_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;

  const response = await fetch(`${CHAT_SERVICE_URL}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: prompt,
      systemPrompt: GLOBAL_SYSTEM_PROMPT,
      responseFormat: "json",
      maxTokens: 3072,
      provider: "google",
      model: "pro",
    }),
  });

  if (response.status === 402) {
    const error = await response.json() as { balance_cents: number; required_cents: number };
    throw new InsufficientCreditsError(error.balance_cents, error.required_cents);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`chat-service /complete failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as ChatCompleteResponse;

  const parsed = parseSequenceFromJson(data.json);

  return {
    ...parsed,
    tokensInput: data.tokensInput,
    tokensOutput: data.tokensOutput,
    model: data.model,
    promptRaw: prompt,
    responseRaw: data,
  };
}

function textToHtml(text: string): string {
  return text
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function parseSequenceFromJson(json: {
  subject: string;
  emails: Array<{ body: string; daysSinceLastStep: number }>;
}): {
  subject: string;
  sequence: SequenceStep[];
} {
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
