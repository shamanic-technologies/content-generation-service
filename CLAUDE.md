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
- `src/lib/expert-quote-pitch-template.ts` — Source of truth for the `expert-quote-pitch` platform template (body + variables metadata)
- `src/lib/register-platform-templates.ts` — Boot-time UPSERT reconcile of platform-owned prompt rows; called from `src/index.ts` after migrations
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
