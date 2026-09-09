// Renders the lead + organization facts a caller supplied but the template
// body never asked for, as a readable block placed ahead of the template.
//
// Why a block rather than `{{tokens}}` in each template: the bodies are stored
// rows, hand-tuned per org across dozens of versions, and a token added to one
// of them reaches only that one. See `lead-context-variables.ts`.
//
// Two invariants this module exists to keep:
//  - A caller sending none of these variables gets a prompt byte-identical to
//    the one it got before this existed (the function returns "").
//  - A fact the template ALREADY consumes via `{{token}}` is never repeated
//    here, so an existing template renders exactly as it always did.
//
// Standalone leaf: it imports only `template-vars.js` (env-free, never mocked)
// and takes the value renderer as an argument, so it does not reach into
// `chat-service-client.js`, which most unit suites replace with a mock.

import { extractTemplateVariableNames } from "./template-vars.js";
import { LEAD_CONTEXT_GROUPS } from "./lead-context-variables.js";

/** A value is worth rendering when it carries something a reader could use. */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

const HEADER = [
  "## Recipient context",
  "Facts about the person receiving this email and the organization they work for.",
  "Use the ones that make the email more relevant and ignore the rest. Do not restate a fact just because it is listed, and never state anything that is not here.",
];

/**
 * Build the recipient-context block for a generation.
 *
 * @param promptTemplate the raw stored template, read for the `{{tokens}}` it consumes
 * @param variables      the caller's variable values
 * @param render         value renderer (`coerceToString` from the chat-service client)
 * @returns the block, or "" when there is nothing to add
 */
export function buildLeadContextBlock(
  promptTemplate: string,
  variables: Record<string, unknown>,
  render: (value: unknown) => string
): string {
  const consumedByTemplate = new Set(extractTemplateVariableNames(promptTemplate));
  const sections: string[] = [];

  for (const group of LEAD_CONTEXT_GROUPS) {
    const lines: string[] = [];
    for (const variable of group.variables) {
      if (consumedByTemplate.has(variable.name)) continue;
      const value = variables[variable.name];
      if (!hasValue(value)) continue;

      const rendered = render(value);
      // A multi-line rendering (object, or array of objects) reads better under
      // its own label than glued onto the bullet.
      lines.push(
        rendered.includes("\n")
          ? `- ${variable.label}:\n${rendered}`
          : `- ${variable.label}: ${rendered}`
      );
    }
    if (lines.length > 0) {
      sections.push([`${group.heading}:`, ...lines].join("\n"));
    }
  }

  if (sections.length === 0) return "";

  return [...HEADER, "", sections.join("\n\n")].join("\n");
}
