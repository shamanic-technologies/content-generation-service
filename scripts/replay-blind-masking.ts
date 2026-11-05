/**
 * BLIND-NAME-LEAK-1105 proof: replays the head of a BLIND dynasty on real clients' recorded inputs,
 * once as the writer saw them before (unmasked) and once masked, and prints whether each email names the
 * client. Prompt only: chat-service `/internal/platform-complete` (support `staff_experiment`, platform
 * billed), nothing stored, nothing sent.
 *
 *   node dist/replay-blind-masking.js <dynastySlug> <brandId>...   (inside the content-generation container)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { generateFromTemplate } from "../src/lib/chat-service-client.js";
import { clientIdentityLeaks, clientIdentityTerms, maskClientIdentity } from "../src/lib/client-identity-mask.js";

const SUPPORT = {
  kind: "staff_experiment",
  reason: "BLIND-NAME-LEAK-1105 replay: a blind template on recorded inputs, masked vs unmasked; nothing stored or sent.",
};

// Every writing call goes to the platform door: the replay is never billed to the client's org.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("/complete") && init?.body) {
    const body = { ...JSON.parse(String(init.body)), support: SUPPORT };
    const headers = { "Content-Type": "application/json", "X-Api-Key": (init.headers as Record<string, string>)["X-Api-Key"] };
    return realFetch(u.replace(/\/complete$/, "/internal/platform-complete"), { method: "POST", headers, body: JSON.stringify(body) });
  }
  return realFetch(url, init);
}) as typeof fetch;

async function main() {
  const [dynasty, ...brandIds] = process.argv.slice(2);
  if (!dynasty || brandIds.length === 0) throw new Error("usage: replay-blind-masking <dynastySlug> <brandId>...");
  const [head] = (await db.execute(sql`
    SELECT p.type, p.prompt FROM template_dynasty_versions v JOIN prompts p ON p.type = v.prompt_type
    WHERE v.dynasty_slug = ${dynasty} ORDER BY v.position DESC LIMIT 1`)) as unknown as Array<{ type: string; prompt: string }>;
  if (!head) throw new Error(`no head for ${dynasty}`);
  console.log(`# Template ${head.type} (head of ${dynasty})\n`);

  for (const brandId of brandIds) {
    const [row] = (await db.execute(sql`
      SELECT variables_raw, chat_request_inputs, chat_request->>'model' AS model, model AS answered FROM email_generations
      WHERE brand_ids = ARRAY[${brandId}]::text[] AND variables_raw ? 'brandExtractedFields'
      ORDER BY created_at DESC LIMIT 1`)) as unknown as Array<{ variables_raw: Record<string, unknown>; chat_request_inputs: Record<string, any> | null; model: string | null; answered: string | null }>;
    if (!row) throw new Error(`no recorded generation with brand intel for brand ${brandId}`);
    // API key only (no identity headers: never a placeholder org), the same rows /generate reads.
    const res = await realFetch(`${process.env.BRAND_SERVICE_URL}/internal/brands?ids=${brandId}`, { headers: { "X-Api-Key": process.env.BRAND_SERVICE_API_KEY ?? "" } });
    if (!res.ok) throw new Error(`brand-service ${res.status}: ${await res.text()}`);
    const brands = ((await res.json()) as { brands: Array<{ id: string; name: string; domain: string; url: string }> }).brands.filter((b) => b.id === brandId);
    const terms = clientIdentityTerms(brands);
    const inputs = row.chat_request_inputs ?? {};
    const model = row.model ?? row.answered ?? "gemini-flash-lite";
    const base = { variables: row.variables_raw, campaignContext: inputs.campaignContext ?? null, giveLists: inputs.giveLists ?? null, instruction: inputs.instruction ?? null };
    console.log(`## ${brands[0].name} (${brands[0].domain}), model ${model}`);
    console.log(`Writer input names the client: before ${clientIdentityLeaks(base, terms).length > 0 ? "yes" : "no"}, after ${clientIdentityLeaks(maskClientIdentity(base, terms), terms).length > 0 ? "yes" : "no"}\n`);
    for (const masked of [false, true]) {
      const seen = masked ? maskClientIdentity(base, terms) : base;
      const result = await generateFromTemplate(
        { promptTemplate: head.prompt, variables: { ...seen.variables }, campaignContext: seen.campaignContext, giveLists: seen.giveLists, instruction: seen.instruction, language: inputs.language ?? null, model },
        { orgId: "", userId: "", runId: "" } as never
      );
      const email = { subject: result.subject, body: result.sequence[0]?.bodyText ?? "" };
      const leaks = clientIdentityLeaks(email, terms);
      console.log(`### ${masked ? "AFTER (masked)" : "BEFORE (unmasked)"}: ${leaks.length > 0 ? `NAMES THE CLIENT (${leaks.join(", ")})` : "client never named"}`);
      console.log(`Subject: ${email.subject}\n\n${email.body}\n`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
