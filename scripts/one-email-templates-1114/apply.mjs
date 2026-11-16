/**
 * ONE-EMAIL-TEMPLATES-1114 activation: adds ONE new version (`<slug>.after.txt`) to each of the 23 email template
 * dynasties through content-generation-service's own door (`POST /internal/template-dynasties/{slug}/versions`), which
 * judges neutrality + the dynasty's identity rule, stores the next `<family>-vN` and deprecates the old head "Upgraded".
 * Scripts state a dynasty slug as their template tactic and read its head per run: the new version writes from the
 * next generation on, no script change.
 *
 * Refuses a dynasty whose head moved since the texts were drafted (`from-heads.json`): its text was written from
 * another version. Dry-run by default (reads heads, checks tokens, writes nothing); `--apply` to write.
 *
 *   node apply.mjs <dir> [--apply] [--by <staff email>]      (inside the container: localhost + its own API key)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args[0];
const apply = args.includes("--apply");
const by = args.includes("--by") ? args[args.indexOf("--by") + 1] : null;
if (!dir) throw new Error("usage: apply.mjs <dir> [--apply] [--by <staff email>]");
if (apply && !by) throw new Error("--apply needs --by <staff email>: recorded as who upgraded the dynasties");

const base = `http://localhost:${process.env.PORT || 3005}`;
const headers = { "Content-Type": "application/json", "X-Api-Key": process.env.CONTENT_GENERATION_SERVICE_API_KEY ?? process.env.API_KEY ?? "" };
if (by) headers["x-staff-email"] = by;
const tokens = (t) => [...new Set([...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

const fromHeads = JSON.parse(readFileSync(join(dir, "from-heads.json"), "utf8"));
let failed = 0;
for (const [slug, fromType] of Object.entries(fromHeads)) {
  const res = await fetch(`${base}/internal/template-dynasties/${slug}/head`, { headers });
  if (!res.ok) { failed++; console.log(`FAIL ${slug}: head ${res.status} ${await res.text()}`); continue; }
  const { template } = await res.json();
  if (template.type !== fromType) { failed++; console.log(`SKIP ${slug}: head is ${template.type}, the text was drafted from ${fromType}`); continue; }
  const prompt = readFileSync(join(dir, `${slug}.after.txt`), "utf8");
  const variables = (template.variables ?? []).filter((v) => tokens(prompt).includes(typeof v === "string" ? v : v.name));
  const declared = variables.map((v) => (typeof v === "string" ? v : v.name)).sort();
  if (JSON.stringify(declared) !== JSON.stringify(tokens(prompt))) { failed++; console.log(`FAIL ${slug}: tokens ${tokens(prompt)} vs head variables ${declared}`); continue; }
  if (!apply) { console.log(`ok ${slug}: ${fromType} -> next version (${prompt.split(/\s+/).length} words)`); continue; }
  const post = await fetch(`${base}/internal/template-dynasties/${slug}/versions`, { method: "POST", headers, body: JSON.stringify({ prompt, variables }) });
  const body = await post.text();
  if (post.status !== 201) { failed++; console.log(`FAIL ${slug}: ${post.status} ${body}`); continue; }
  console.log(`UPGRADED ${slug}: ${fromType} -> ${JSON.parse(body).template.type}`);
}
console.log(`${apply ? "applied" : "dry run"}: ${Object.keys(fromHeads).length - failed}/${Object.keys(fromHeads).length} ok`);
process.exit(failed ? 1 : 0);
