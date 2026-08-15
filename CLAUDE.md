# Project: content-generation-service

Microservice that generates personalized content (emails, calendar events, etc.) via chat-service (which handles LLM calls, key resolution, billing, and cost tracking), with PostgreSQL storage and run tracking via runs-service.

## Commands

- `pnpm test` — run all tests (Vitest)
- `pnpm test:unit` — run unit tests only
- `pnpm test:integration` — run integration tests only
- `pnpm run build` — compile TypeScript + generate OpenAPI spec
- `pnpm run dev` — local dev server (tsx watch)
- `pnpm run generate:openapi` — regenerate `openapi.json` from Zod schemas
- `pnpm db:generate` — generate Drizzle migrations
- `pnpm db:migrate` — run database migrations
- `pnpm db:push` — push schema to database
- `pnpm db:studio` — open Drizzle Studio

## Architecture

- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth for validation + OpenAPI)
- `src/routes/generate.ts` — POST /generate endpoint (email generation via chat-service)
- `src/routes/stats.ts` — POST /stats and POST /stats/by-model endpoints
- `src/routes/health.ts` — GET /health endpoint
- `src/middleware/auth.ts` — Authentication middleware (X-Clerk-Org-Id header)
- `src/lib/chat-service-client.ts` — Chat-service client + email template utilities (prompt substitution, JSON parsing)
- `src/lib/chat-models.ts` — `CHAT_MODELS` alias set + `MODEL_TO_PROVIDER` map + `DEFAULT_MODEL`. Standalone (NOT in chat-service-client.ts) so `schemas.ts` can read the enum at module-eval without the ~13 suites that `vi.mock` chat-service-client.js crashing `z.enum(undefined)`
- `src/lib/escaped-line-breaks.ts` — `unescapeLineBreaks` (multi-line text) + `collapseEscapedLineBreaks` (single-line fields). LLM output sometimes returns newlines OVER-ESCAPED (the two characters `\` + `n` instead of U+000A); `textToHtml` splits on real newlines only, so an over-escaped body rendered as one paragraph with visible `\n` in the prospect's inbox (53/40,979 delivered campaigns, 2026-05-27 → 2026-07-30). Applied at every point this service emits LLM text a human reads: email `bodyText`/`bodyHtml` (`parseSequenceFromJson`) and the free-text pitch (`cleanPitchText`). The **subject** uses `collapseEscapedLineBreaks` instead — it is a header, so unescaping there would open a header-injection path the literal text does not have. Text with no escaped line break is returned byte-identical, so real-newline output is unchanged. Standalone leaf module (never `vi.mock`'d)
- `src/lib/text-to-html.ts` — `textToHtml` (blank line → `<p>`, single newline → `<br>`). Standalone leaf so the historical repair regenerates HTML with the exact generation-time conversion instead of a copy
- `src/lib/escaped-line-break-repair.ts` + `scripts/repair-escaped-line-breaks.ts` — one-shot repair of generations stored BEFORE the generation-time fix. `repairSequence` decides per step via `unescapeLineBreaks(t) !== t` (no second implementation of the conversion), rewrites `bodyText` and REGENERATES `bodyHtml` from it; returns `null` for a clean sequence so clean rows/steps stay byte-identical and a second run is a no-op. The script is dry-run by default (`--apply` to write) and ends by READING BACK the still-dirty counts from `email_generations` + `email_examples_silver` — an already-applied idempotent run prints zeros, which alone is indistinguishable from a no-op. Never wired into a request or boot path: the data is wrong at rest and is fixed at rest, never on read. Ran against prod 2026-08-01 (50 rows / 148 steps, window 2026-05-27 → 2026-07-30)
- `src/lib/tracking.ts` — Single source for downstream identity + tracking/attribution headers: `Tracking` type, `TRACKING_HEADER_KEYS` allowlist, `extractTracking(req)`, `buildTrackingHeaders(t)`. Every internal client builds its headers through this — see "Tracking / attribution headers" below
- `src/lib/runs-client.ts` — Client for runs-service (run tracking)
- `src/lib/key-client.ts` — Client for key-service (used by submagic route)
- `src/lib/expert-quote-pitch-template.ts` — Source of truth for the `expert-quote-pitch` platform template (body + variables metadata) + `assertExpertQuotePitchVariables` (presence-only input guard over the three generic-JSON variables `expert`/`brands`/`journalistRequest`)
- `src/lib/register-platform-templates.ts` — Boot-time UPSERT reconcile of platform-owned prompt rows; called from `src/index.ts` after migrations
- `src/lib/prompt-versioning.ts` — `findNextVersionType` + `createPromptVersion` fork helper (shared by `PUT /prompts` and `PUT /prompt-assignments`)
- `src/lib/prompt-assignment.ts` — `resolveAssignedPromptType(featureSlug)` + `assertPromptVariablesMatch` integrity guard
- `src/lib/template-vars.ts` — `extractTemplateVariableNames` (env-free `{{var}}` parser; single source of truth for the token regex)
- `src/routes/prompt-assignments.ts` — GET/PUT /prompt-assignments (per-feature prompt resolution + fork-and-reassign)
- `src/lib/examples-query.ts` — Gold-layer cascade for `GET /generations/examples` (`fetchWorkflowExamples` + `toExampleEmail`); reads the silver view
- `src/db/schema.ts` — Drizzle ORM database schema
- `src/db/index.ts` — Database connection
- `src/instrument.ts` — Sentry instrumentation
- `src/config.ts` — Environment config
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated from Zod schemas, do NOT edit manually

## Platform-owned prompt templates

The `prompts` table stores prompt templates keyed by `type` (unique). Two ownership tiers:

1. **Platform-owned** (`org_id IS NULL`) — source of truth lives in code under `src/lib/*-template.ts`. Reconciled on every boot by `registerPlatformTemplates()` via `INSERT ... ON CONFLICT (type) DO UPDATE` — body, variables metadata, and `updated_at` always match the source. Skip-if-exists is forbidden here because changes to the source must propagate without manual reseed.
2. **Org-tuned versions** — created via `PUT /prompts` under a versioned slug (`<type>-v2`, `<type>-v3`, …). Different `type` value → never touched by the platform reconcile loop.

To add a new platform template: create `src/lib/<name>-template.ts` exporting `TYPE`, `TEMPLATE`, and `VARIABLES: Array<{ name, description }>`, then append the entry to `PLATFORM_TEMPLATES` in `src/lib/register-platform-templates.ts`.

The `variables` array is the self-describing contract callers use to construct the request body for `POST /generate` and `POST /generate-expert-quote-pitch`. Keep descriptions precise — external callers discover input shape via `GET /platform-prompts?type=<type>`.

### `expert-quote-pitch` input contract (three generic-JSON blobs)

The request type stays `variables: Record<string, unknown>` (DIS-52 — no per-field Zod schema; callers keep JSON flexibility). Required-ness is enforced at **runtime** by `assertExpertQuotePitchVariables(variables, declaredVariables)`, called in the route before any LLM spend → **400 fail-loud** if anything is missing/empty. The platform template declares **three generic-JSON variables**, each just checked for **presence + non-empty** — NO per-field structural validation:
1. **`expert`** — freeform JSON for the person whose quote gets published (name/title/bio/photo/linkedin/answer angle+context). The old granular `expertName`/`expertTitle`/`expertBio`/`expertPhotoUrl`/`expertLinkedIn`/`expertAnswerContext` are folded into this one blob.
2. **`brands`** — freeform JSON for the brand(s) the expert represents. Multibrand default (usually an array), but ANY non-empty shape passes. The old required brand sub-fields (`brandName`/`brandUrl`/…) are gone — a bare `{ name }` is accepted.
3. **`journalistRequest`** — freeform JSON describing the journalist's request.

The guard is intentionally NOT severe on the inner shape — the blobs are markdown-coerced straight into the prompt, so the model reads whatever the caller sends. (This deliberately reversed the old all-required-per-sub-field guard, which 400'd pitches on missing attribution-only fields like `brandLogoUrl`.)

**Changing the variable set is a hard break** for callers (journalists-quotes-service / windmill DAG + dashboard `/draft` via api-service proxy) AND invalidates every existing org fork (`expert-quote-pitch-v*`, old token set). When the contract changes, ship a data migration that `DELETE`s the stale `feature_prompt_assignment` rows (`prompt_type LIKE 'expert-quote-pitch-v%'`) + the stale fork rows (`prompts.type LIKE 'expert-quote-pitch-v%'`) so the feature falls back to the rebuilt platform default. See `drizzle/0027_reset_expert_quote_pitch_forks_generic_json.sql` (latest; `0024` was the prior reset). The api-service proxy is pass-through (body owned by this service) — no gateway change.

**BACK UP THE FORKS BEFORE THE RESET DELETE — org forks are hand-tuned prompt copy, not disposable.** A reset migration's `DELETE FROM prompts WHERE type LIKE 'expert-quote-pitch-v%'` destroys real org customization (e.g. org `f0420eb5` had `v2…v5`, ~a month of tuning, `v5` actively assigned to feature `pr-expert-quote-opportunities`). Recovery now depends entirely on whatever backup the self-hosted Postgres box holds — there is no Neon PITR window any more, so treat the DELETE as unrecoverable. Before shipping any `expert-quote-pitch-v%` reset: (1) dump the fork rows + their `feature_prompt_assignment` rows to a file (`SELECT json_agg(...) FROM prompts WHERE type LIKE 'expert-quote-pitch-v%'`), commit it under `drizzle/` or `.context/`; (2) after the contract change, re-port each active fork's BODY onto the new token set (the fork's `{{tokens}}` only live in its Inputs block — the rest of the tuned body is reusable verbatim) and re-INSERT under a fresh `-vN` + re-assign. Incident 2026-07-03: `0027` wiped `f0420eb5`'s `v5`; restored via a PITR branch (`neonctl branches create --parent <ts-before-delete>`) → the `v5` body ported to the 3-blob contract as `expert-quote-pitch-v6`, feature reassigned. The DELETE-without-backup should never have shipped in `0027`.

## Per-feature prompt assignment

`feature_prompt_assignment (feature_slug PK, prompt_type, updated_at)` maps a feature slug to the prompt type rendered for it. Feature-global (NOT org/brand scoped — brand facts arrive via `{{brands}}` at generation time).

- **Resolution order** (`POST /generate-expert-quote-pitch`): explicit `templateType` ▸ feature assignment for `featureSlug` ▸ platform default `expert-quote-pitch`. `resolveAssignedPromptType()` covers the last two; the route applies `templateType` before calling it.
- `GET /prompt-assignments?featureSlug=` returns the resolved prompt; `isDefault = (resolvedType === platform default)`.
- `PUT /prompt-assignments` forks the resolved type (reusing `createPromptVersion`, source never mutated) then upserts the assignment. The `{{var}}` tokens in the submitted prompt MUST exactly match the source's declared variable-name set — `assertPromptVariablesMatch` throws → 400 naming the offending var, nothing forked/assigned.
- The two `/prompt-assignments` endpoints use `serviceAuthRunOptional` (x-org-id + x-user-id required, **x-run-id optional**) — an operator/dashboard prompt-editor save has no run context. Do NOT loosen `serviceAuth` itself; other routes depend on `req.runId!` being present.

## Per-request model selection

`POST /generate` and `POST /generate-expert-quote-pitch` accept an optional `model` field — a version-free alias from `CHAT_MODELS` (`haiku`, `sonnet`, `opus`, `flash-lite`, `flash`, `flash-pro`, `pro`, `deepseek-flash`, `deepseek-pro`). Caller picks the LLM per request; omitted → `DEFAULT_MODEL` (`pro`/google), byte-identical to before the field existed.

- **Provider is derived, never sent by the caller.** The 9 aliases are unique across providers, so `MODEL_TO_PROVIDER` maps alias→provider (`chat-models.ts`). No `provider` field on the wire → the provider/model-mismatch error class can't happen.
- **`deepseek-flash` + `deepseek-pro` → provider `deepseek`.** chat-service v0.51.0 removed the Vercel AI Gateway (it resold these models well above the vendors' list prices) and now calls DeepSeek, Z.ai and Moonshot directly over their OpenAI-compatible APIs, each resolving its own key-service credential. The slug `vercel` is GONE from `/complete` + `/internal/platform-complete`, so a request still carrying it is 400-rejected before it reaches a model — that is the bug fixed in v0.28.3. The model aliases themselves did not move. Both alias spellings and the provider slug are chat-service's, not ours — read them off its **deployed** `/complete` schema (prod api-registry), do NOT invent either. That direct-vendor path is **text-in / text-out only**: chat-service 400s on `webSearch` / `imageUrl`, and neither of this service's two generation paths sends either field, so nothing here needs a capability the models lack. The one caveat is JSON mode — `/generate` sends a `responseSchema` and neither DeepSeek V4 model advertises `response_format` support, so the vendor may ignore the schema. Best-effort but never silent: chat-service's JSON parse fails loud (502) on unreadable output, so a bad sequence is an error, not a half-filled email. The pitch route sends no schema and is unaffected. chat-service also serves `glm-flash`/`glm-pro` (zai) and `kimi-flash`/`kimi-pro` (moonshot); this service deliberately does not expose them yet.
- **`/generate` response schema is provider-conditional.** `GENERATE_RESPONSE_SCHEMA` (permissive) is sent for google AND deepseek (DeepSeek's OpenAI-compatible API imposes no `additionalProperties` requirement); `GENERATE_RESPONSE_SCHEMA_STRICT` (`additionalProperties:false` on the object AND `emails.items`) only for anthropic — anthropic's structured-output API 400s on permissive schemas, google ignores the keyword. The google path is unchanged. The pitch route is free-text (no responseSchema) → all 9 work as-is.
- **No new persistence / cost handling.** chat-service bills per resolved provider+model; the resolved versioned id is already stored in `email_generations.model` and surfaced by `/stats?groupBy=model`, so model-comparison analytics work for free.
- Adding a model is a 1-line edit to `CHAT_MODELS` + `MODEL_TO_PROVIDER`; the Zod enum + OpenAPI regenerate from `CHAT_MODELS`.

## Data layering (medallion)

This repo owns a **logical** bronze → silver → gold layering for the workflow example-email feature. It is logical, not three physical tables (Databricks: medallion is "recommended, not required"; Lakshmanan: minimize copies, keep gold small; Baeyens: "medallion is NOT a data model"). One index + one view; gold derives on read.

| Layer | Where | What |
|-------|-------|------|
| 🥉 Bronze | `email_generations` table | Raw, append-only generation log — one row per generation. Immutable (no SCD). Source of truth. |
| 🥈 Silver | `email_examples_silver` **view** (`drizzle/0025`) | Cleansed (drops content-less / failed generations) + conformed (stable example column set) projection over bronze. Plain VIEW — **never materialized**, never written directly, rebuildable from bronze. Declared in `src/db/schema.ts` as `pgView(...).existing()`. |
| 🥇 Gold | `src/lib/examples-query.ts` (`fetchWorkflowExamples`) | Parameterized cascade (current brand → same-org other brands → any org) computed at read time. "Kept small" = `limit` N. No stored gold. |

**Evolution trigger:** materialize silver (or add a gold table) ONLY if profiling shows the cross-org global tier is slow at scale. Until then the plain view + `idx_emailgen_workflow` index is the floor. Do not add a refresh job / accumulator — that reintroduces state the view avoids.

## Tracking / attribution headers

Identity + attribution headers (`x-run-id`, `x-campaign-id`, `x-brand-id`, `x-workflow-slug`, `x-feature-slug`, `x-audience-id`) flow through ONE allowlist in `src/lib/tracking.ts` — `TRACKING_HEADER_KEYS`. **Never cherry-pick header fields per client.** To add a new attribution dimension:
1. Add the field to the `Tracking` interface + a `[field, "x-header"]` entry to `TRACKING_HEADER_KEYS`.
2. Add it to `AuthenticatedRequest` + the inbound parse in `serviceAuth` (auth.ts).
3. Thread the resolved value (body `||` header) into the identity objects in `generate.ts`.
4. If it must tag a runs-service cost/run row, that's automatic once forwarded — runs-service reads the header (header > body > parent inheritance). If you persist it locally, add the `email_generations` column + migration.

Every internal client (runs/chat/campaign/brand/key) builds its headers via `buildTrackingHeaders(identity)` — they pick up new dimensions for free.

**EGRESS GUARDRAIL:** `buildTrackingHeaders` output is for INTERNAL services only. NEVER forward tracking headers to a third-party vendor. This service makes no direct vendor calls (LLM via chat-service), so the strip holds by construction — if a direct vendor client is ever added, it MUST build request headers WITHOUT `buildTrackingHeaders`.

`x-audience-id` is the campaign-chosen priority audience; it's optional (absent outside a campaign flow → omit, never throw). Attribution in runs-service is a flat `SUM(cost) GROUP BY COALESCE(runs_costs.audience_id, runs.audience_id)` — no hierarchical rollup, so every cost/run row must carry it. NOTE: the LLM spend is a **chat-service** cost row, not content-gen's; tagging it requires chat-service to read `x-audience-id` inbound (separate repo).

## Gotchas

- **pnpm only** — the tracked lockfile is `pnpm-lock.yaml`. Never commit a stray `package-lock.json`; delete it before committing.
- **Unit tests fully-mock `src/db/schema.js` and `src/middleware/auth.js`** (full `vi.mock` replacement, NOT `importOriginal`) — ~12-18 files each. So a route/module that reads a NEW export from either at **module-eval time** (an express middleware arg in `router.get(path, mw, h)`, or a top-level `const cols = { id: view.id }`) crashes EVERY one of those test files with `[vitest] No "<export>" export is defined on the "<module>" mock`, even though the test never exercises that route. Fix: **defer the access past module-eval** — wrap the middleware in an arrow (`(req,res,next) => newAuthFn(req,res,next)`) so the binding is read at request time, and build column/select maps lazily inside the query function, not at top level. Do NOT add the export to all N mocks (brittle — the next new export re-breaks them). Reference: `src/routes/generate.ts` `/generations/examples` middleware wrap + `src/lib/examples-query.ts` `silverColumns()`. **The SAME class extends to ANY module many suites `vi.mock` without re-exporting its constants — not just schema.js/auth.js.** `src/lib/chat-service-client.js` is `vi.mock`'d by ~13 suites; when `schemas.ts` imported a new `CHAT_MODELS` const from it for a top-level `z.enum(CHAT_MODELS)`, every one of those 13 crashed at module-eval with `z.enum(undefined)` (`CHAT_MODELS` was undefined under the mock) — and `schemas.ts` is reachable from every route, so it cascaded. Fix: **keep module-eval-read constants in a standalone, never-mocked module** (`src/lib/chat-models.ts` holds `CHAT_MODELS`/`MODEL_TO_PROVIDER`/`DEFAULT_MODEL`; `schemas.ts` + `chat-service-client.ts` both import from it). Rule of thumb: before importing a const into `schemas.ts` (or any top-level `z.enum`/`z.literal`/column-map), check whether the source module is `vi.mock`'d anywhere — if yes, move the const to its own leaf module. **Run the FULL `pnpm test:unit` locally before pushing** (not just your new test file) — this whole class breaks sibling suites and only the full run surfaces it; there is no local DB so CI is the ONLY gate for integration, making the local full unit run your one pre-push safety net.
- **A one-shot repair script's DRY-RUN does not exercise the WRITE — the first `--apply` is the first time the update is ever bound.** The dry-run reads, decides, and prints; every parameter-binding, casting and driver quirk on the write path is untested until the run that touches prod. Concretely here: postgres.js `sql.json()` rejects a top-level ARRAY (it hands the value to `Buffer.byteLength` → `ERR_INVALID_ARG_TYPE: Received an instance of Array`), and a stored `sequence` is always an array — so `scripts/repair-escaped-line-breaks.ts` passed its dry-run cleanly and crashed on the first UPDATE (fixed in v0.28.1: bind `JSON.stringify(value)` and cast `::jsonb`). It failed before any write, but a script that had already written N rows would have stopped mid-sweep. So: for any repair/backfill, either exercise the write against a throwaway row first, or accept that the apply run needs the same attention as the dry-run — and always SNAPSHOT the rows the dry-run says it will touch (`.context/pre-repair-snapshot-*.json`) before the first `--apply`, so the write is reversible.
- **Integration tests run only in CI, against a `postgres:16` service container created for that run and destroyed with it — the database starts EMPTY.** (It used to be a Neon branch forked from production; Neon is gone.) Three consequences: (1) **`tests/setup.ts` replays the whole `drizzle/` journal from nothing, fail-loud.** A migration statement that only works against an already-populated database now aborts the replay — that is how `0000`'s bare `ALTER TABLE "email_generations" DROP COLUMN`, sitting BEFORE its own `CREATE TABLE`, was finally caught. `tests/unit/migration-empty-db-replay.test.ts` pins the class without a database: every statement naming a relation must guard itself (`ALTER TABLE IF EXISTS`) or name one an earlier migration creates. (2) **A new migration must be replayable from empty**, not just applicable to prod — write `IF EXISTS` / `IF NOT EXISTS` guards, and put a data backfill after the DDL it depends on. (3) **A failing integration test on the staging→main merge commit makes the deploy SKIP** (it gates on the merge commit's check-suite) — the deploy shows `in_progress`→`inactive`, never `success`.
- **Two `drizzle/*.sql` files are NOT in `meta/_journal.json` and have never been run by the migrator**: `0001_fix_emailgen_indexes.sql` (superseded — `0000` already creates those indexes non-unique, confirmed against prod) and `0012_rename_delaydays_to_daysssincelaststep.sql` (a one-shot data backfill applied by hand). A file in `drizzle/` is inert unless the journal lists it; the journal is the source of truth, not the directory.
- **`pnpm db:generate` prompts on pre-existing drift** — the deprecated `content_generations` table is out of sync with the meta snapshots, so drizzle-kit asks create-vs-rename for unrelated columns. For a simple new table, hand-author `drizzle/<n>_*.sql` (`CREATE TABLE IF NOT EXISTS`) + a matching `drizzle/meta/_journal.json` entry (`when` > the previous entry's). The runtime migrator only checks the journal `when`, not snapshots.
