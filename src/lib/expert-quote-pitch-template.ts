// Stored prompt template for journalist-quote pitch generation (Featured.com).
// Registered at boot; consumed by POST /generate-expert-quote-pitch.
//
// Char range 100-2500 is enforced server-side after generation; we still ask the
// model to land inside that window to minimise retries.
//
// Inputs are declared as { name, description }. The caller decides the JSON
// shape per name — string, object, or array. Multibrand is the default, so
// `brand` typically arrives as an object or as an array of brand profiles.

export const EXPERT_QUOTE_PITCH_TYPE = "expert-quote-pitch";

export const EXPERT_QUOTE_PITCH_VARIABLES = [
  {
    name: "brand",
    description:
      "JSON describing the expert / brand speaking. Multibrand is the default — caller may pass an array of brand profiles, a single object, or any shape that captures who is speaking. Common fields: name, industry, expertise, voice, targetAudience. When multiple brands are provided, the model treats them as a collective speaker.",
  },
  {
    name: "request",
    description:
      "JSON describing the journalist's request. Common fields: question (string), mediaOutlet (string|null), source (string|null — reporter name), deadline (string).",
  },
  {
    name: "additionalContext",
    description:
      "Optional free-form extra context the caller wants the model to consider. String or object — caller's choice.",
  },
];

export const EXPERT_QUOTE_PITCH_TEMPLATE = `You are an expert pitching a quote in response to a journalist's request on Featured.com.

## Expert profile
{{brand}}

## Journalist request
{{request}}

## Additional context
{{additionalContext}}

## Task
Write the pitch the expert will submit as their answer. The pitch must:
- Address the journalist's question directly with a concrete, opinionated take.
- Sound like the expert speaking — match the voice / tone described above.
- Reference the expert's specific experience, data, or examples (no generic platitudes).
- When the expert profile describes multiple brands, speak as the collective — never invent a single primary if multiple are given. Weave them naturally when each contributes a distinct perspective.
- Be between 100 and 2500 characters total. Aim for 600-1200 characters.
- Read like a quote a journalist would paste into a story.

Strict bans (these are AI-giveaway phrases — never use them):
- "As an expert in", "As a [role]", "In today's fast-paced world", "It's important to note", "It's worth noting", "In conclusion", "Furthermore", "Moreover", "delve into", "navigate the landscape", "in the realm of", "leverage", "synergy", "ultimately", "at the end of the day".

Other rules:
- No preamble, no sign-off, no "Hi [Reporter]", no "Hope this helps". Output is the pitch body only.
- No markdown headings, no bullet lists unless the question explicitly calls for a list of items.
- No placeholders like [Your name], [Company], [Insert X].
- Output plain text only. No JSON, no quotes around the response, no labels.

Return ONLY the pitch text.`;
