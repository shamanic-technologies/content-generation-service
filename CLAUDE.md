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
- `src/lib/runs-client.ts` — Client for runs-service (run tracking)
- `src/lib/key-client.ts` — Client for key-service (used by submagic route)
- `src/lib/expert-quote-pitch-template.ts` — Source of truth for the `expert-quote-pitch` platform template (body + variables metadata) + `assertExpertQuotePitchVariables` (all-required input guard) + `EXPERT_QUOTE_PITCH_BRAND_FIELDS`
- `src/lib/register-platform-templates.ts` — Boot-time UPSERT reconcile of platform-owned prompt rows; called from `src/index.ts` after migrations
- `src/lib/prompt-versioning.ts` — `findNextVersionType` + `createPromptVersion` fork helper (shared by `PUT /prompts` and `PUT /prompt-assignments`)
- `src/lib/prompt-assignment.ts` — `resolveAssignedPromptType(featureSlug)` + `assertPromptVariablesMatch` integrity guard
- `src/lib/template-vars.ts` — `extractTemplateVariableNames` (env-free `{{var}}` parser; single source of truth for the token regex)
- `src/routes/prompt-assignments.ts` — GET/PUT /prompt-assignments (per-feature prompt resolution + fork-and-reassign)
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

### `expert-quote-pitch` explicit input contract (all-required)

The request type stays `variables: Record<string, unknown>` (DIS-52 — no per-field Zod schema; callers keep JSON flexibility). Required-ness is enforced at **runtime** by `assertExpertQuotePitchVariables(variables, declaredVariables)`, called in the route before any LLM spend → **400 fail-loud** if anything is missing/empty. Two layers:
1. **Every declared variable** (driven by the resolved template's `variables` metadata) must be present + non-empty.
2. **`brands` is multibrand** — ALWAYS an array of objects, each carrying all `EXPERT_QUOTE_PITCH_BRAND_FIELDS` (`brandName`, `brandUrl`, `brandDescription`, `brandHeadquartersLocation`, `brandLogoUrl`) non-empty. The nested sub-fields can't be seen by the top-level `{{token}}` scan, so they get a structural check. Expert attribution is single (`expertName`/`expertTitle`/`expertBio`/`expertPhotoUrl`/`expertLinkedIn`, names mirror features-service campaign inputs / DIS-136). Request fields: `journalistRequest`, `expertAnswerContext`.

**Changing the variable set is a hard break** for callers (journalists-quotes-service DAG + dashboard `/draft` via api-service proxy) AND invalidates every existing org fork (`expert-quote-pitch-v*`, old token set). When the contract changes, ship a data migration that `DELETE`s the stale `feature_prompt_assignment` rows (`prompt_type LIKE 'expert-quote-pitch-v%'`) + the stale fork rows (`prompts.type LIKE 'expert-quote-pitch-v%'`) so the feature falls back to the rebuilt platform default. See `drizzle/0024_reset_expert_quote_pitch_forks.sql`. The api-service proxy is pass-through (body owned by this service) — no gateway change.

## Per-feature prompt assignment

`feature_prompt_assignment (feature_slug PK, prompt_type, updated_at)` maps a feature slug to the prompt type rendered for it. Feature-global (NOT org/brand scoped — brand facts arrive via `{{brands}}` at generation time).

- **Resolution order** (`POST /generate-expert-quote-pitch`): explicit `templateType` ▸ feature assignment for `featureSlug` ▸ platform default `expert-quote-pitch`. `resolveAssignedPromptType()` covers the last two; the route applies `templateType` before calling it.
- `GET /prompt-assignments?featureSlug=` returns the resolved prompt; `isDefault = (resolvedType === platform default)`.
- `PUT /prompt-assignments` forks the resolved type (reusing `createPromptVersion`, source never mutated) then upserts the assignment. The `{{var}}` tokens in the submitted prompt MUST exactly match the source's declared variable-name set — `assertPromptVariablesMatch` throws → 400 naming the offending var, nothing forked/assigned.
- The two `/prompt-assignments` endpoints use `serviceAuthRunOptional` (x-org-id + x-user-id required, **x-run-id optional**) — an operator/dashboard prompt-editor save has no run context. Do NOT loosen `serviceAuth` itself; other routes depend on `req.runId!` being present.

## Gotchas

- **pnpm only** — the tracked lockfile is `pnpm-lock.yaml`. Never commit a stray `package-lock.json`; delete it before committing.
- **`pnpm db:generate` prompts on pre-existing drift** — the deprecated `content_generations` table is out of sync with the meta snapshots, so drizzle-kit asks create-vs-rename for unrelated columns. For a simple new table, hand-author `drizzle/<n>_*.sql` (`CREATE TABLE IF NOT EXISTS`) + a matching `drizzle/meta/_journal.json` entry (`when` > the previous entry's). The runtime migrator only checks the journal `when`, not snapshots.
