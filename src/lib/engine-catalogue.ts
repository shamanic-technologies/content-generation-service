/**
 * Engines as features-service's catalogue states them (RESEARCH-BY-ENGINE-1113-CG, owner 2026-11-13: Research is keyed by
 * Engine and script; pipes, legs, channels, plays and workflows are removed from our vocabulary).
 *
 * An Engine = the outcome it makes (`email_sent`). The Engine of one (channel x step pair) of the catalogue
 * (`GET /public/channels`, `channels[].stepTransitions[]`) is its `outcome`, else its `to` step: the rule campaign-service
 * (`pipeEngineOutcome`) and features-service's Research by Engine run. Never a list kept here: a pair staff publish
 * tomorrow places its Engine at once.
 *
 * Template dynasties and the old per-pair routes still name a (featureSlug, legKey) pair: this is the one place that
 * turns one into its Engine.
 */
import { fetchChannelCatalogue, transitionOnCatalogue, type CatalogueTransition, type ChannelCatalogue, type CataloguePipe } from "./pipe-from-step.js";

export class EngineCatalogueError extends Error {
  constructor(
    readonly status: 404 | 502,
    readonly code: "UNKNOWN_ENGINE" | "ENGINE_CATALOGUE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
  toResponseBody() {
    return { error: this.message, code: this.code };
  }
}

/** Pure: the Engine a catalogue transition makes. */
export const engineOfTransition = (t: CatalogueTransition): string | null => t.outcome || t.to?.key || null;

/** Pure: the Engine of (featureSlug, legKey) (a legacy step spelling resolved); null = not in the catalogue. */
export function engineOfPair(catalogue: ChannelCatalogue, pair: CataloguePipe): string | null {
  const t = transitionOnCatalogue(catalogue, pair);
  return t ? engineOfTransition(t) : null;
}

/** Pure: every Engine the catalogue states. */
export function enginesOnCatalogue(catalogue: ChannelCatalogue): Set<string> {
  const out = new Set<string>();
  for (const c of catalogue.channels) {
    for (const t of c.stepTransitions) {
      const e = engineOfTransition(t);
      if (e) out.add(e);
    }
  }
  return out;
}

async function catalogue(): Promise<ChannelCatalogue> {
  try {
    return await fetchChannelCatalogue();
  } catch (err) {
    throw new EngineCatalogueError(502, "ENGINE_CATALOGUE_UNAVAILABLE", `features-service Engine catalogue unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The Engine asked for, checked against the catalogue: 404 `UNKNOWN_ENGINE`, 502 when the catalogue is unreadable. */
export async function assertEngine(engine: string): Promise<string> {
  const engines = enginesOnCatalogue(await catalogue());
  if (!engines.has(engine)) {
    throw new EngineCatalogueError(404, "UNKNOWN_ENGINE", `No Engine "${engine}" in features-service's catalogue. Engines: ${[...engines].sort().join(", ")}`);
  }
  return engine;
}

/** The Engine of one (featureSlug, legKey) pair; null = the pair is not in the catalogue. 502 when unreadable. */
export async function engineOfPairLive(pair: CataloguePipe): Promise<string | null> {
  return engineOfPair(await catalogue(), pair);
}

/** Pure: of the given pairs, those whose Engine is `engine`. */
export function pairsOfEngine<P extends CataloguePipe>(cat: ChannelCatalogue, pairs: readonly P[], engine: string): P[] {
  return pairs.filter((p) => engineOfPair(cat, p) === engine);
}

/** Of the given pairs, those whose Engine is `engine`, on the live catalogue (502 when unreadable). */
export async function pairsOfEngineLive<P extends CataloguePipe>(pairs: readonly P[], engine: string): Promise<P[]> {
  return pairsOfEngine(await catalogue(), pairs, engine);
}
