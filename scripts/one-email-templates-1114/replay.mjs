/**
 * ONE-EMAIL-TEMPLATES-1114 proof: replays recorded production cold-email requests twice, once with the template
 * version that wrote them (BEFORE) and once with the drafted one-email version (AFTER). Same lead, same inputs,
 * same LLM, same system prompt: only the template part of the message changes. Platform door
 * (`/internal/platform-complete`, support `staff_experiment`): nothing stored, nothing sent, no client billed.
 *
 * The message the writer received = [campaign context] [relationship] [recipient context] + the rendered template.
 * The recipient context depends only on the template's {{tokens}}, which a new version keeps, so
 * AFTER = the recorded message with its rendered-template suffix replaced. A row whose message does not end with
 * the re-rendered template is skipped (reported), never approximated.
 *
 *   node scripts/one-email-templates-1114/replay.mjs <cases.jsonl> <templates.json> <out.json> [concurrency]
 *   cases.jsonl: one `{ id, dynasty, brand, recorded }` per line (`recorded` = email_generations.recorded_text)
 *   templates.json: `{ <dynasty>: { before: <text>, after: <text> } }`
 * Run inside the content-generation-service container (CHAT_SERVICE_URL + CHAT_SERVICE_API_KEY).
 */
import { readFileSync, writeFileSync } from "node:fs";

const SUPPORT = {
  kind: "staff_experiment",
  reason: "ONE-EMAIL-TEMPLATES-1114 replay: recorded cold-email requests, old vs new template version; nothing stored or sent.",
};

// Byte-for-byte port of src/lib/chat-service-client.ts coerceToString / substituteVariables.
function humanizeKey(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").trim().toLowerCase();
}
function renderObjectAsMarkdown(obj, indent) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const label = humanizeKey(k);
    if (typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${indent}- ${label}:`);
      lines.push(renderObjectAsMarkdown(v, indent + "  "));
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      lines.push(`${indent}- ${label}: ${v.join(", ")}`);
    } else if (Array.isArray(v) && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
      lines.push(`${indent}- ${label}:`);
      v.forEach((item, i) => {
        lines.push(`${indent}  ${i + 1}.`);
        lines.push(renderObjectAsMarkdown(item, indent + "     "));
      });
    } else {
      lines.push(`${indent}- ${label}: ${coerceToString(v)}`);
    }
  }
  return lines.join("\n");
}
function coerceToString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value.join(", ");
    if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
      return value.map((item, i) => `${i + 1}.\n${renderObjectAsMarkdown(item, "   ")}`).join("\n");
    }
    return JSON.stringify(value);
  }
  return renderObjectAsMarkdown(value, "");
}
function substituteVariables(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) result = result.replaceAll(`{{${key}}}`, coerceToString(value));
  return result;
}

const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

async function complete(request) {
  const res = await fetch(`${process.env.CHAT_SERVICE_URL}/internal/platform-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": process.env.CHAT_SERVICE_API_KEY ?? "" },
    body: JSON.stringify({ ...request, support: SUPPORT }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`chat-service ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  const parsed = body.json ?? JSON.parse(String(body.content).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const first = parsed.emails?.[0]?.body ?? "";
  return { subject: parsed.subject ?? "", body: first, model: body.model ?? null };
}

async function main() {
  const [casesPath, templatesPath, outPath, conc = "6"] = process.argv.slice(2);
  const cases = readFileSync(casesPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const templates = JSON.parse(readFileSync(templatesPath, "utf8"));
  const results = [];
  const skipped = [];
  const queue = [...cases];
  async function worker() {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const rec = JSON.parse(c.recorded);
      const t = templates[c.dynasty];
      if (!t) { skipped.push({ id: c.id, why: "no template pair" }); continue; }
      const renderedOld = substituteVariables(rec.inputs?.promptTemplate ?? t.before, rec.variables);
      const message = rec.request.message;
      if (!message.endsWith(renderedOld)) { skipped.push({ id: c.id, why: "message does not end with the rendered template" }); continue; }
      const prefix = message.slice(0, message.length - renderedOld.length);
      const after = { ...rec.request, message: prefix + substituteVariables(t.after, rec.variables) };
      try {
        const [b, a] = await Promise.all([complete(rec.request), complete(after)]);
        results.push({ id: c.id, dynasty: c.dynasty, brand: c.brand, model: rec.request.model, before: { ...b, words: words(b.body) }, after: { ...a, words: words(a.body) } });
        console.log(`${c.dynasty} ${c.brand} ${rec.request.model}: ${words(b.body)} -> ${words(a.body)}`);
      } catch (e) {
        skipped.push({ id: c.id, why: String(e.message ?? e) });
        console.log(`ERR ${c.id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Number(conc) }, worker));
  writeFileSync(outPath, JSON.stringify({ results, skipped }, null, 1));
  console.log(`done: ${results.length} pairs, ${skipped.length} skipped`);
}

main().catch((e) => { console.error(e); process.exit(1); });
