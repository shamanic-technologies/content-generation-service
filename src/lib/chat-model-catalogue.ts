/**
 * Every model name chat-service's `/complete` accepts, read from chat-service itself
 * (LLM-DYNASTY-1022-CG). Never a list kept here: chat-service owns the vocabulary
 * (LLM dynasty slugs like `claude-opus` / `gemini-flash`, each head's exact model id,
 * and the legacy aliases `opus` / `flash-pro` it keeps as redirects), and a copy drifted
 * every time it shipped a model.
 *
 * Source: chat-service `GET /internal/models`, one row per accepted name with the
 * provider it runs on (and, once dynasties are deployed, the dynasty it belongs to).
 * The provider sent to `/complete` is read from that row, never derived from the name.
 *
 * Cached for CACHE_TTL_MS. A name absent from a cached copy older than MISS_REFRESH_MS
 * re-reads once, so a model chat-service has just shipped is usable at once. Unreadable
 * catalogue → `ChatModelCatalogueError` (502): nothing is generated with a guessed provider.
 * Unknown name → `UnknownModelError` (400 `UNKNOWN_MODEL`).
 *
 * Standalone leaf (imports only fetch-retry), stubbed once for every unit suite in
 * `tests/setup.ts`; `tests/unit/chat-model-catalogue.test.ts` exercises the real module.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { ChatProvider } from "./chat-models.js";

export interface ChatModelEntry {
  /** A name `/complete` accepts, as the caller writes it. */
  model: string;
  provider: ChatProvider;
  /** LLM dynasty slug of the model the name runs; null while chat-service serves none. */
  dynasty: string | null;
}

export class UnknownModelError extends Error {
  status = 400;
  code = "UNKNOWN_MODEL";
  constructor(public model: string, public accepted: string[]) {
    super(`Unknown model "${model}". chat-service accepts: ${accepted.join(", ")}`);
    this.name = "UnknownModelError";
  }
}

export class ChatModelCatalogueError extends Error {
  status = 502;
  code = "MODEL_CATALOGUE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "ChatModelCatalogueError";
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MISS_REFRESH_MS = 30 * 1000;

let cache: { at: number; entries: ChatModelEntry[] } | null = null;

/** Test hook: forget the cached catalogue. */
export function resetChatModelCatalogueCache(): void {
  cache = null;
}

async function fetchCatalogue(): Promise<ChatModelEntry[]> {
  const base = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${base}/internal/models`,
      { method: "GET", headers: { "X-Api-Key": process.env.CHAT_SERVICE_API_KEY || "" } },
      { label: "chat-service GET /internal/models" }
    );
  } catch (err) {
    throw new ChatModelCatalogueError(
      `chat-service model catalogue unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ChatModelCatalogueError(
      `chat-service model catalogue unreadable: ${response.status} - ${text.slice(0, 300)}`
    );
  }
  const body = (await response.json()) as { models?: unknown };
  if (!Array.isArray(body.models) || body.models.length === 0) {
    throw new ChatModelCatalogueError("chat-service model catalogue has no models");
  }
  const entries: ChatModelEntry[] = [];
  for (const row of body.models as Array<Record<string, unknown>>) {
    if (typeof row?.model !== "string" || typeof row?.provider !== "string") {
      throw new ChatModelCatalogueError(`chat-service model catalogue row unreadable: ${JSON.stringify(row)}`);
    }
    entries.push({
      model: row.model,
      provider: row.provider as ChatProvider,
      dynasty: typeof row.dynasty === "string" ? row.dynasty : null,
    });
  }
  return entries;
}

async function load(maxAgeMs: number): Promise<ChatModelEntry[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.entries;
  const entries = await fetchCatalogue();
  cache = { at: Date.now(), entries };
  return entries;
}

/** Every name chat-service accepts, in its order. */
export async function listChatModels(): Promise<ChatModelEntry[]> {
  return load(CACHE_TTL_MS);
}

/** The catalogue row of `model`, or null when chat-service does not accept it. */
export async function findChatModel(model: string): Promise<ChatModelEntry | null> {
  const hit = (await load(CACHE_TTL_MS)).find((e) => e.model === model);
  if (hit) return hit;
  return (await load(MISS_REFRESH_MS)).find((e) => e.model === model) ?? null;
}

/** The catalogue row of `model`; throws `UnknownModelError` when chat-service does not accept it. */
export async function resolveChatModel(model: string): Promise<ChatModelEntry> {
  const hit = await findChatModel(model);
  if (hit) return hit;
  throw new UnknownModelError(model, (cache?.entries ?? []).map((e) => e.model));
}
