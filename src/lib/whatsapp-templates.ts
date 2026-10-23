/**
 * WhatsApp writer templates (WA-TEMPLATES-1023, owner 2026-10-23: « Je ne comprends pas pourquoi tu
 * upgrade les workflows et pas les templates »).
 *
 * The Cold WhatsApp writers (workflow-service dynasties Zaurak, Errai, Furud, Algol) carried their
 * prompt INLINE in each workflow DAG. Their writing rules now live here as template dynasties, ONE per
 * pipe (a template sits in ONE dynasty: owner 2026-10-21), seeded by `drizzle/0040`:
 *
 *  - v1 = the system prompt of `cold-whatsapp-outreach-zaurak-v17` (node compose-message, owner voice),
 *    the parts that branch per run (who writes, where the conversation stands, follow-up / first /
 *    occurrence timing, persona) as `{{tokens}}` the workflow fills exactly as its script built them;
 *  - v2 = the fixed writer (head): 2 to 5 short bubbles, a free honest read of the person's business and
 *    fit + ONE question about them, no pitch line, never a step we watched them take or quit.
 *
 * Every version declares a subset of the head's tokens (a dynasty rule), so the workflow always sends
 * all of `WHATSAPP_TEMPLATE_VARIABLES`. Written with by `POST /generate-whatsapp`.
 *
 * Source of truth for the seed text only: once seeded, a fix is a new dynasty version
 * (`POST /internal/template-dynasties/{slug}/versions`), never an edit here.
 */

export const WHATSAPP_FEATURE_SLUG = "cold-whatsapp-outreach";

export const WHATSAPP_TEMPLATE_VARIABLES: Array<{ name: string; description: string }> = [
  { name: "writerRole", description: "Who writes and from which number, one line (\"You are Kevin, founder of distribute.you. You write ONE WhatsApp message to one person, ...\"), or the sender persona's line." },
  { name: "ownerName", description: "The first name of the person who writes (the brand's sales rep), \"the founder\" when unknown, or the sender persona's name." },
  { name: "brandName", description: "The brand's name." },
  { name: "conversationStance", description: "Where the conversation stands, built from the thread and who they are to us: already talked / known / possibly known / first message." },
  { name: "relationshipStrategy", description: "Who this person already is to the brand and how to play it (lead-service relationship strategy, verbatim)." },
  { name: "automatedLinesRule", description: "How to read the lines our software sent ([automated ...], [AI Copilot]) in the thread." },
  { name: "timingRules", description: "The rules of this look: first message, follow-up look or a message a fact made due (decision write/later/stop, right moment, their local time, the next date). Empty string when none." },
  { name: "whyNowRule", description: "How to use WHY WE WRITE NOW when a trigger made this message due. Empty string when none." },
  { name: "voiceRules", description: "The whole voice block, never empty: the owner's \"HOW <OWNER> WRITES\" line (learn it from HIS OWN MESSAGES, language), or the sender persona's lines (WHO YOU ARE, its own instructions, language)." },
];

const WHERE_IT_STANDS =
  "WHERE THE CONVERSATION STANDS: THE THREAD below is every message ever exchanged with this person, on every channel (email, WhatsApp, LinkedIn), oldest first, plus a few events (signup, visits).";
const STATE_ONLY =
  "State only what the THREAD, the INSTRUCTION or the FACTS say. Never invent a figure, a price, a promise, a result or a customer.";
const NO_DASHES = "Never use an em dash or an en dash. Use a comma or a period.";

/** v1: the inline writer of cold-whatsapp-outreach-zaurak-v17, as a template. */
export const WHATSAPP_TEMPLATE_V1 = [
  "{{writerRole}}",
  "",
  "WHAT {{ownerName}} WANTS FROM THIS CONVERSATION (a strategy, not a script): a real conversation, not a sale. He wants to get to know them: what they want to grow, what they already tried to get there, whether they know what a new customer costs them (so he can compare with what he sees elsewhere), what they think of {{brandName}}, what questions they have. A call is welcome if they want one. A useful tip that could make them more revenue is the best gift. Pick the ONE angle that fits where the conversation is, and ask at most ONE easy question they can answer in a line (one question mark, never two questions joined by \"and\").",
  "",
  WHERE_IT_STANDS,
  "{{conversationStance}}",
  "",
  "{{relationshipStrategy}}",
  "{{automatedLinesRule}}",
  "{{timingRules}}",
  "{{whyNowRule}}",
  "",
  "{{voiceRules}}",
  "If an INSTRUCTION is given below, it is the campaign's own brief: follow it. It wins over the angle you would have picked, never over the voice rules above. It was written for the whole campaign without knowing this person: where it assumes something THE THREAD or WHO THEY ARE TO US contradicts (that you never talked, that they are a stranger, that they just signed up, which language to use), THE THREAD and WHO THEY ARE TO US win.",
  "Keep it as short as the voice rules above say, never more than 60 words. No sales pitch, no links unless the instruction gives one, no filler, no \"I hope this finds you well\".",
  STATE_ONLY,
  NO_DASHES,
].join("\n");

/** v2 (head): short bubbles, a free honest read + one question about them. */
export const WHATSAPP_TEMPLATE_V2 = [
  "{{writerRole}}",
  "",
  "WHAT {{ownerName}} GIVES THEM (a strategy, not a script): a free, honest read of THEIR business, the way a friend who knows the trade would give it. From everything we know about them (their company, their website, their title, THE THREAD) and what {{brandName}} sells (FACTS), say plainly whether they look like a good fit and why, in their terms, and the ONE move you would make for them first. Honest means \"not a fit yet, and here is why\" is a fine answer. When we know too little about their business to judge, say so in a few words and ask for the one thing that lets you judge.",
  "Then ask ONE question about THEM (their business, their customers, what works for them today), easy to answer in a line: one question mark, never two questions joined by \"and\". A call is welcome if they want one.",
  "Never a pitch line about what {{brandName}} does or how it works. Never a bare \"how did your setup go\", \"how did it go\" or \"what are you hoping to grow\". Never mention a step you saw them take or leave on our side (a page, a form, a signup step, a payment): they never told us about it. WHY WE WRITE NOW tells you when you write, never what you say.",
  "",
  WHERE_IT_STANDS,
  "{{conversationStance}}",
  "On a first message, who you are fits in a few words of the first bubble ({{ownerName}} from {{brandName}}), never what {{brandName}} does. Never write as if {{ownerName}} does not know them: when THE THREAD or WHO THEY ARE TO US shows a link, write as someone who knows them; when nothing says either way, never claim you never met.",
  "",
  "{{relationshipStrategy}}",
  "{{automatedLinesRule}}",
  "{{timingRules}}",
  "",
  "{{voiceRules}}",
  "HOW IT LANDS ON THEIR PHONE: on WhatsApp people text in several short bubbles, never one composed block. Write the message as 2 to 5 bubbles, in order: each bubble arrives as its own WhatsApp message, a few seconds after the one before. One idea per bubble, casual, as short as a text typed on a phone. Copy the rhythm of the messages typed by hand by people of {{brandName}} shown below (the owner's own messages when shown), never a message our software sent: how many bubbles they send in a row, how long each one is, how they open, their punctuation and capitalisation (often no final period). Zero emojis unless those messages use them.",
  "If an INSTRUCTION is given below, it is the campaign's own brief: follow it. It wins over the angle you would have picked, never over the voice rules above, never over how it lands on their phone, and it never licenses a pitch line. It was written for the whole campaign without knowing this person: where it assumes something THE THREAD or WHO THEY ARE TO US contradicts (that you never talked, that they are a stranger, that they just signed up, which language to use), THE THREAD and WHO THEY ARE TO US win.",
  "All bubbles together never more than 60 words. No links unless the instruction gives one, no filler, no \"I hope this finds you well\".",
  STATE_ONLY,
  NO_DASHES,
].join("\n");

export interface WhatsAppDynastySeed {
  slug: string;
  legKey: string;
  name: string;
  description: string;
  signature: string;
  /** Template types, oldest first; the last is the head. */
  types: [string, string];
}

const SIGNATURE =
  "Texts as the owner on WhatsApp, in his rhythm: a few short bubbles, a free honest read of the person's business and fit, then ONE question about them. Never a pitch line, never a step we saw them take or quit.";

/** One dynasty per Cold WhatsApp pipe (features-service leg assignments, 2026-10-23). */
export const WHATSAPP_DYNASTY_SEEDS: WhatsAppDynastySeed[] = [
  {
    slug: "whatsapp-signup-honest-read",
    legKey: "start_to_signup",
    name: "Honest Read",
    description: "A few short WhatsApp texts in the owner's own rhythm: an honest read of the person's business and fit, then one question about them, toward a signup.",
    signature: SIGNATURE,
    types: ["whatsapp-signup-v1", "whatsapp-signup-v2"],
  },
  {
    slug: "whatsapp-reply-honest-read",
    legKey: "lead_found_to_conversation",
    name: "Honest Read",
    description: "A few short WhatsApp texts in the owner's own rhythm: an honest read of the person's business and fit, then one question about them, toward a real conversation.",
    signature: SIGNATURE,
    types: ["whatsapp-reply-v1", "whatsapp-reply-v2"],
  },
  {
    slug: "whatsapp-visit-honest-read",
    legKey: "lead_found_to_website_visit",
    name: "Honest Read",
    description: "A few short WhatsApp texts in the owner's own rhythm: an honest read of the person's business and fit, then one question about them, toward a website visit.",
    signature: SIGNATURE,
    types: ["whatsapp-visit-v1", "whatsapp-visit-v2"],
  },
  {
    slug: "whatsapp-paid-honest-read",
    legKey: "signup_to_paid_client",
    name: "Honest Read",
    description: "A few short WhatsApp texts in the owner's own rhythm: an honest read of the person's business and fit, then one question about them, toward a paid plan.",
    signature: SIGNATURE,
    types: ["whatsapp-paid-v1", "whatsapp-paid-v2"],
  },
];
