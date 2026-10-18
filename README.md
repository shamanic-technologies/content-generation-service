# Content Generation Service

A microservice for generating personalized content (emails, calendar events, etc.) using Claude Sonnet 4.6.

## Features

- Generates personalized content using Anthropic Claude Sonnet 4.6
- Stores generations in PostgreSQL with Drizzle ORM
- BYOK (Bring Your Own Key) support for Anthropic API keys
- Cost tracking integration with runs-service
- Health endpoint for container orchestration
- Every email is written in our one voice: chat-service's `client-comms` skill, read live on each generation (no copy; unreadable = 502, nothing written)

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL with Drizzle ORM
- **AI:** Anthropic Claude Sonnet 4.6
- **Monitoring:** Sentry
- **Testing:** Vitest

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL database

### Installation

```bash
# Install dependencies
pnpm install

# Run database migrations
pnpm db:migrate

# Start development server
pnpm dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```env
CONTENT_GENERATION_SERVICE_DATABASE_URL='postgresql://...'
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
KEY_SERVICE_URL='http://localhost:3001'
PORT=3005
```

## API Endpoints

### Health Check
```
GET /health
```

### Generate Email
```
POST /generate
Headers: X-Clerk-Org-Id: <org_id>
Body: {
  runId: string,
  apolloEnrichmentId: string,
  leadFirstName: string,
  leadCompanyName: string,
  clientCompanyName: string,
  // ... additional lead and client info
}
```

### Get Generations
```
GET /generations/:runId
Headers: X-Clerk-Org-Id: <org_id>
```

## Development

```bash
# Run tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests
pnpm test:integration

# Open Drizzle Studio
pnpm db:studio
```

## Docker

```bash
# Build
docker build -t content-generation-service .

# Run
docker run -p 3005:3005 --env-file .env content-generation-service
```

## License

MIT
