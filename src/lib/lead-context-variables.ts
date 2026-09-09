// Lead + organization context variables every prompt template accepts.
//
// The email templates are hand-tuned per org and live in dozens of stored
// versions (`cold-email-v9` … `cold-email-v41`, `blind-discovery-email-v26`, …),
// so a fact the model should always be able to read cannot be added by editing
// bodies: an org fork written tomorrow would not have it, and rewriting stored
// copy destroys tuning nobody can recover. Same reasoning as the language
// directive in `chat-service-client.ts` — the rule lives in code and reaches
// every template, present and future, without touching a single row.
//
// These names are OPTIONAL inputs on `POST /generate`. A caller that sends none
// of them gets the prompt it got before this existed, byte for byte. Values
// that ARE sent and are not already consumed by a `{{token}}` in the template
// body are rendered into a "Recipient context" block ahead of the template
// (see `lead-context-block.ts`).
//
// The names follow the convention the templates already use: `lead*` for the
// person, `leadCompany*` for their organization. lead-service is the producer
// of every one of them; nothing here is derived or invented on this side.
//
// This catalog is published on every prompt read (`GET /prompts`,
// `GET /platform-prompts`) as `contextVariables`, so a caller building its
// variable mapping discovers the whole accepted set live rather than from a
// document.

export interface PromptContextVariable {
  name: string;
  /** Human label used as the bullet key when the value is rendered into the prompt. */
  label: string;
  description: string;
}

/** Person-level facts. */
const PERSON_VARIABLES: PromptContextVariable[] = [
  { name: "leadFirstName", label: "first name", description: "The recipient's first name." },
  { name: "leadLastName", label: "last name", description: "The recipient's last name." },
  { name: "leadTitle", label: "job title", description: "The recipient's job title at their current organization." },
  { name: "leadHeadline", label: "headline", description: "The recipient's own one-line description of what they do, usually from LinkedIn." },
  { name: "leadSeniority", label: "seniority", description: "Seniority level of the recipient's role, e.g. 'founder', 'c_suite', 'vp', 'manager', 'entry'." },
  { name: "leadDepartments", label: "departments", description: "Departments the recipient belongs to. String or array of strings, e.g. ['engineering', 'information_technology']." },
  { name: "leadSubdepartments", label: "sub-departments", description: "Finer-grained departments the recipient belongs to, below `leadDepartments`. String or array of strings, e.g. ['devops', 'information_technology']." },
  { name: "leadFunctions", label: "functions", description: "Job functions the recipient covers. String or array of strings, e.g. ['sales', 'business_development']." },
  { name: "leadCity", label: "city", description: "City the recipient works from." },
  { name: "leadState", label: "state or region", description: "State, province, or region the recipient works from." },
  { name: "leadCountry", label: "country", description: "Country the recipient works from." },
  { name: "leadTimezone", label: "timezone", description: "The recipient's IANA timezone, e.g. 'Europe/Paris'. Useful for referring to their working hours, never for scheduling claims you cannot keep." },
  { name: "leadBusinessLanguages", label: "business languages", description: "Languages the recipient does business in, ISO 639-1 codes, ordered most plausible first. The language the email is written in is resolved separately from lead-service; this is context, not an instruction." },
  { name: "leadLinkedinUrl", label: "LinkedIn profile", description: "URL of the recipient's LinkedIn profile." },
  {
    name: "leadEmploymentHistory",
    label: "employment history",
    description:
      "The recipient's past and current roles, most recent first. Array of objects, each with any of: title, company, start (date string), end (date string or null), current (boolean). Rendered as a numbered list in the prompt.",
  },
];

/** Organization-level facts about the recipient's current employer. */
const ORGANIZATION_VARIABLES: PromptContextVariable[] = [
  { name: "leadCompanyName", label: "name", description: "Name of the recipient's current organization." },
  { name: "leadCompanyDescription", label: "description", description: "What the organization does, in prose." },
  { name: "leadCompanySeoDescription", label: "short description", description: "The organization's own short public description, as published on its site." },
  { name: "leadCompanyIndustry", label: "industry", description: "Primary industry of the organization." },
  { name: "leadCompanyIndustries", label: "industries", description: "Industries the organization operates in. String or array of strings." },
  { name: "leadCompanySecondaryIndustries", label: "secondary industries", description: "Additional industries the organization operates in, beyond the primary one. String or array of strings." },
  { name: "leadCompanyKeywords", label: "keywords", description: "Keywords the organization is described by. String or array of strings." },
  { name: "leadCompanyTechStack", label: "tech stack", description: "Technologies the organization is known to use. String or array of strings." },
  { name: "leadCompanySize", label: "headcount", description: "Number of employees, or an employee range." },
  { name: "leadCompanyFoundedYear", label: "founded year", description: "Year the organization was founded." },
  { name: "leadCompanyAnnualRevenue", label: "annual revenue", description: "Annual revenue of the organization, as served by lead-service. May be a number or a formatted range." },
  { name: "leadCompanyFundingStage", label: "funding stage", description: "Latest funding stage, e.g. 'seed', 'series_a'." },
  { name: "leadCompanyLatestFundingRoundDate", label: "latest funding round date", description: "Date of the organization's most recent funding round, as served by lead-service. Usually an ISO date ('2024-06-01'), sometimes free text." },
  { name: "leadCompanyTotalFunding", label: "total funding raised", description: "Total capital raised by the organization." },
  {
    name: "leadCompanyFundingEvents",
    label: "funding events",
    description:
      "Funding rounds the organization has raised, most recent first. Array of objects, each with any of: type, date, amount, currency, investors. Rendered as a numbered list in the prompt.",
  },
  { name: "leadCompanyWebsiteUrl", label: "website", description: "URL of the organization's website." },
  { name: "leadCompanyLinkedinUrl", label: "LinkedIn page", description: "URL of the organization's LinkedIn page." },
  { name: "leadCompanyCity", label: "city", description: "City of the organization's headquarters." },
  { name: "leadCompanyState", label: "state or region", description: "State, province, or region of the organization's headquarters." },
  { name: "leadCompanyCountry", label: "country", description: "Country of the organization's headquarters." },
];

/** Ordered groups, used to render the context block under readable headings. */
export const LEAD_CONTEXT_GROUPS: Array<{ heading: string; variables: PromptContextVariable[] }> = [
  { heading: "Person", variables: PERSON_VARIABLES },
  { heading: "Organization", variables: ORGANIZATION_VARIABLES },
];

/** Flat catalog of every accepted context variable, person first. */
export const LEAD_CONTEXT_VARIABLES: PromptContextVariable[] = LEAD_CONTEXT_GROUPS.flatMap(
  (g) => g.variables
);

/**
 * The catalog as published on prompt reads: `{ name, description }` only, the
 * same self-describing shape as a template's own declared `variables`.
 */
export const LEAD_CONTEXT_VARIABLES_PUBLISHED: Array<{ name: string; description: string }> =
  LEAD_CONTEXT_VARIABLES.map(({ name, description }) => ({ name, description }));
