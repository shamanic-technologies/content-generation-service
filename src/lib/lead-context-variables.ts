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
  /**
   * Optional dedicated renderer for a structured value. Returns the lines to
   * place under the group heading, or null when the value carries nothing
   * usable (then nothing is rendered for it). Absent → the generic renderer.
   */
  format?: (value: unknown) => string[] | null;
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

/**
 * The buying signal lead-service serves on a lead from a signal audience:
 * `{ type, occurredOn, fact, source, sourceUrl }`. `fact` is one English
 * sentence meant to be quoted. Rendered as the fact plus its kind and date;
 * `source` / `sourceUrl` are provenance for us, not copy for the prospect, so
 * they never reach the prompt. A value without a usable `fact` renders nothing:
 * the signal is never reconstructed from its other fields.
 */
export function formatBuyingSignal(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const signal = value as Record<string, unknown>;
  const fact = typeof signal.fact === "string" ? signal.fact.trim() : "";
  if (!fact) return null;
  const lines = [`- what happened: ${fact}`];
  if (typeof signal.type === "string" && signal.type.trim()) {
    lines.push(`- kind: ${signal.type.trim().replace(/_/g, " ")}`);
  }
  if (typeof signal.occurredOn === "string" && signal.occurredOn.trim()) {
    lines.push(`- date: ${signal.occurredOn.trim()}`);
  }
  return lines;
}

/**
 * Signal kinds the email may quote. The signal always chooses WHO we write to;
 * only these kinds may also shape WHAT we write. Any other kind (today
 * `linkedin_engagement`: the person reacted to or commented on a competitor's
 * LinkedIn post, which reads as surveillance) never reaches the model at all,
 * neither in the recipient-context block nor through a `{{leadBuyingSignal}}`
 * token. A new kind is not quotable until it is added here.
 */
export const QUOTABLE_BUYING_SIGNAL_TYPES: ReadonlySet<string> = new Set(["hiring", "job_change", "funding"]);

/**
 * The caller's variables minus a buying signal whose kind may not be quoted.
 * Returns the same object when there is nothing to drop, so every other
 * request is untouched.
 */
export function withoutUnquotableBuyingSignal(
  variables: Record<string, unknown>
): Record<string, unknown> {
  const signal = variables.leadBuyingSignal;
  // Not a signal object: the context block already renders nothing for it.
  if (signal === null || typeof signal !== "object" || Array.isArray(signal)) return variables;
  const type = (signal as Record<string, unknown>).type;
  if (typeof type === "string" && QUOTABLE_BUYING_SIGNAL_TYPES.has(type.trim())) return variables;
  const { leadBuyingSignal: _dropped, ...rest } = variables;
  return rest;
}

/** A recent event observed at the recipient or their organization. */
const SIGNAL_VARIABLES: PromptContextVariable[] = [
  {
    name: "leadBuyingSignal",
    label: "buying signal",
    description:
      "A recent event that makes this recipient worth writing to now, exactly as lead-service serves it on the lead: an object with type ('hiring', 'job_change' or 'funding'), occurredOn (YYYY-MM-DD), fact (one English sentence meant to be quoted), source and sourceUrl. Rendered as the fact, its kind and its date; the email may reference it. Any other type (e.g. 'linkedin_engagement') is accepted and never shown to the model: it chose the recipient, it does not shape the message. Omit the key entirely when the lead carries no signal.",
    format: formatBuyingSignal,
  },
];

/** How each check verdict lead-service serves reads to the writer. */
const QUALIFICATION_OUTCOMES: Record<string, string> = {
  yes: "pass",
  no: "fail",
  unavailable: "could not check",
  not_checked: "not checked yet",
};

/** How each check mode reads to the writer: the client's own words for it. */
const QUALIFICATION_ROLES: Record<string, string> = {
  must_pass: "Hard filter",
  mention: "Bonus",
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The checks of the campaign's offer, run on the recipient's company, exactly
 * as lead-service serves them on the lead (`lead.qualification`):
 * `{ domain, checks: [{ question, mode, verdict, evidence, screenshotUrl, reason, ... }] }`.
 * Every check is rendered, passed or failed: a failed check is information too.
 * Nothing is re-judged or summarized here; the evidence sentence is carried as
 * lead-service stated it. `checks: []` (an offer with no checks) renders
 * nothing, silently. A value that is not that shape renders nothing (logged),
 * and so does a check without a question: a verdict on no question is noise.
 */
export function formatQualificationChecks(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const qualification = value as Record<string, unknown>;
  if (!Array.isArray(qualification.checks)) return null;

  const lines: string[] = [];
  const domain = nonEmptyString(qualification.domain);
  if (domain && qualification.checks.length > 0) lines.push(`- company checked: ${domain}`);

  let n = 0;
  for (const raw of qualification.checks) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const check = raw as Record<string, unknown>;
    const question = nonEmptyString(check.question);
    if (!question) continue;
    n += 1;
    lines.push(`${n}. ${question}`);
    const mode = nonEmptyString(check.mode);
    if (mode) lines.push(`   role: ${QUALIFICATION_ROLES[mode] ?? mode}`);
    const verdict = nonEmptyString(check.verdict);
    if (verdict) lines.push(`   outcome: ${QUALIFICATION_OUTCOMES[verdict] ?? verdict}`);
    const evidence = nonEmptyString(check.evidence);
    if (evidence) lines.push(`   evidence: ${evidence}`);
    // Why it could not be checked. On a pass or fail the evidence says it.
    const reason = nonEmptyString(check.reason);
    if (reason && verdict !== "yes" && verdict !== "no") lines.push(`   reason: ${reason}`);
    const screenshotUrl = nonEmptyString(check.screenshotUrl);
    if (screenshotUrl) lines.push(`   screenshot: ${screenshotUrl}`);
  }

  if (qualification.checks.length > 0 && n === 0) return null;
  return lines;
}

/** What the offer's checks found about the recipient's company. */
const QUALIFICATION_VARIABLES: PromptContextVariable[] = [
  {
    name: "leadQualification",
    label: "company checks",
    description:
      "Every enabled check of the campaign's offer, run on the recipient's company, exactly as lead-service serves it on the lead (`lead.qualification`): an object { domain, checks: [{ criterionId, offerId, question, mode ('must_pass' = Hard filter, 'mention' = Bonus), source, verdict ('yes' | 'no' | 'unavailable' | 'not_checked'), yesProbability, evidence, screenshotUrl, reason, checkedAt }] }. Passed AND failed checks are rendered: each check's question, role, outcome (pass, fail, could not check), evidence sentence, and screenshot link when there is one. Context only: nothing tells the model to mention it; a template that wants it used says so. `checks: []` or an absent key leaves the prompt unchanged.",
    format: formatQualificationChecks,
  },
];

/** Ordered groups, used to render the context block under readable headings. */
export const LEAD_CONTEXT_GROUPS: Array<{ heading: string; variables: PromptContextVariable[] }> = [
  { heading: "Person", variables: PERSON_VARIABLES },
  { heading: "Organization", variables: ORGANIZATION_VARIABLES },
  {
    heading:
      "Recent buying signal (an event we observed; you may reference it as the reason for writing now, stated as given and without embellishment)",
    variables: SIGNAL_VARIABLES,
  },
  {
    heading:
      "Checks we ran on their company (what we measured, passed or failed; use it only where it makes the email more relevant)",
    variables: QUALIFICATION_VARIABLES,
  },
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
