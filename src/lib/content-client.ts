import Anthropic from "@anthropic-ai/sdk";
import { appendAiDisclaimer } from "./anthropic-client.js";

const MODEL = "claude-sonnet-4-6";

// ─── Content (email) generation ─────────────────────────────────────────────

export interface GenerateContentParams {
  prompt: string;
  variables?: string[];
  includeFooter?: boolean;
  aiDisclaimer?: boolean;
}

export interface GenerateContentResult {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  tokensInput: number;
  tokensOutput: number;
  promptRaw: string;
  responseRaw: object;
}

export async function generateContent(
  apiKey: string,
  params: GenerateContentParams
): Promise<GenerateContentResult> {
  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = buildContentSystemPrompt(params);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: params.prompt }],
  });

  const textContent = response.content.find((c) => c.type === "text");
  const text = textContent?.type === "text" ? textContent.text : "";

  let parsed = parseEmailResponse(text);

  if (params.aiDisclaimer) {
    const patched = appendAiDisclaimer(parsed.bodyHtml, parsed.bodyText);
    parsed = { ...parsed, ...patched };
  }

  return {
    ...parsed,
    tokensInput: response.usage.input_tokens,
    tokensOutput: response.usage.output_tokens,
    promptRaw: `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${params.prompt}`,
    responseRaw: response,
  };
}

function buildContentSystemPrompt(params: GenerateContentParams): string {
  const parts: string[] = [
    "You are an expert email copywriter. Generate email content based on the user's prompt.",
    "",
    "## Output Format",
    "You MUST output exactly this format:",
    "",
    "SUBJECT: [subject line]",
    "---",
    "[email body in plain text]",
    "",
    "Do NOT include anything before SUBJECT: or after the body.",
  ];

  if (params.variables?.length) {
    parts.push(
      "",
      "## Variables",
      "The following variables are available for runtime interpolation. Insert them as {{variableName}} placeholders wherever contextually appropriate in both the subject and body:",
      ...params.variables.map((v) => `- {{${v}}}`),
    );
  }

  if (params.includeFooter) {
    parts.push(
      "",
      "## Footer",
      "Include a footer section at the end of the email body, separated by a blank line. The footer should contain relevant legal/unsubscribe text appropriate to the email context.",
    );
  } else {
    parts.push(
      "",
      "## Footer",
      "Do NOT include any footer, signature block, or unsubscribe text. It will be appended separately.",
    );
  }

  return parts.join("\n");
}

function parseEmailResponse(text: string): {
  subject: string;
  bodyHtml: string;
  bodyText: string;
} {
  const lines = text.trim().split("\n");
  let subject = "";
  const bodyLines: string[] = [];
  let inBody = false;

  for (const line of lines) {
    if (line.startsWith("SUBJECT:")) {
      subject = line.replace("SUBJECT:", "").trim();
    } else if (line.trim() === "---") {
      inBody = true;
    } else if (inBody) {
      bodyLines.push(line);
    }
  }

  const bodyText = bodyLines.join("\n").trim();
  const bodyHtml = bodyText
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  return { subject, bodyHtml, bodyText };
}

// ─── Calendar generation ────────────────────────────────────────────────────

export interface GenerateCalendarParams {
  prompt: string;
}

export interface GenerateCalendarResult {
  title: string;
  description: string;
  location: string | null;
  tokensInput: number;
  tokensOutput: number;
  promptRaw: string;
  responseRaw: object;
}

export async function generateCalendar(
  apiKey: string,
  params: GenerateCalendarParams
): Promise<GenerateCalendarResult> {
  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = [
    "You are an expert copywriter. Generate compelling calendar event fields based on the user's prompt.",
    "",
    "## Output Format",
    'You MUST output valid JSON only, with no surrounding text or markdown code fences:',
    "",
    '{',
    '  "title": "Event title — concise and compelling",',
    '  "description": "Event description — engaging, informative, 2-4 sentences",',
    '  "location": "Location string, or null if not applicable"',
    '}',
    "",
    "Output ONLY the JSON object. No explanation, no markdown.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: params.prompt }],
  });

  const textContent = response.content.find((c) => c.type === "text");
  const text = textContent?.type === "text" ? textContent.text : "";

  const parsed = parseCalendarResponse(text);

  return {
    ...parsed,
    tokensInput: response.usage.input_tokens,
    tokensOutput: response.usage.output_tokens,
    promptRaw: `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${params.prompt}`,
    responseRaw: response,
  };
}

function parseCalendarResponse(text: string): {
  title: string;
  description: string;
  location: string | null;
} {
  const cleaned = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      title: String(parsed.title || ""),
      description: String(parsed.description || ""),
      location: parsed.location ? String(parsed.location) : null,
    };
  } catch {
    throw new Error(`Failed to parse calendar response as JSON: ${text.slice(0, 200)}`);
  }
}
