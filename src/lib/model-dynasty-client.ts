/**
 * The concrete model ids of one LLM dynasty, read from chat-service `GET /internal/model-dynasties`
 * (MODEL-OUTPUTS-1024-CG). chat-service owns dynasties and their versions; a generation stores the
 * concrete id that answered (`claude-opus-5-5`, `gemini-3.1-pro-preview`), so "what this dynasty wrote"
 * is every row whose model is one of its versions, old ones included. Never a list kept here.
 *
 * Unknown dynasty → `ModelDynastyNotFoundError` (404). chat-service unreadable → `ModelDynastyCatalogueError`
 * (502): an outage is never "this dynasty wrote nothing". Standalone leaf.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export class ModelDynastyNotFoundError extends Error {
  status = 404;
  code = "MODEL_DYNASTY_NOT_FOUND";
  constructor(public slug: string) {
    super(`chat-service knows no LLM dynasty "${slug}"`);
    this.name = "ModelDynastyNotFoundError";
  }
}

export class ModelDynastyCatalogueError extends Error {
  status = 502;
  code = "MODEL_CATALOGUE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "ModelDynastyCatalogueError";
  }
}

export interface ModelDynastyVersions {
  slug: string;
  name: string;
  /** Every concrete model id of the dynasty, head first. */
  modelIds: string[];
}

export async function resolveModelDynastyVersions(slug: string): Promise<ModelDynastyVersions> {
  const base = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${base}/internal/model-dynasties`,
      { method: "GET", headers: { "X-Api-Key": process.env.CHAT_SERVICE_API_KEY || "" } },
      { label: "chat-service GET /internal/model-dynasties" }
    );
  } catch (err) {
    throw new ModelDynastyCatalogueError(
      `chat-service model dynasties unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ModelDynastyCatalogueError(`chat-service model dynasties unreadable: ${response.status} - ${text.slice(0, 300)}`);
  }
  const body = (await response.json()) as { dynasties?: unknown };
  if (!Array.isArray(body.dynasties)) {
    throw new ModelDynastyCatalogueError("chat-service model dynasties carried no dynasties list");
  }
  const row = (body.dynasties as Array<Record<string, unknown>>).find((d) => d?.slug === slug);
  if (!row) throw new ModelDynastyNotFoundError(slug);
  const ids = new Set<string>();
  if (typeof row.headModelId === "string") ids.add(row.headModelId);
  for (const m of Array.isArray(row.models) ? (row.models as Array<Record<string, unknown>>) : []) {
    if (typeof m?.modelId === "string") ids.add(m.modelId);
  }
  if (ids.size === 0) throw new ModelDynastyCatalogueError(`chat-service dynasty "${slug}" lists no model id`);
  return { slug, name: typeof row.name === "string" ? row.name : slug, modelIds: [...ids] };
}
