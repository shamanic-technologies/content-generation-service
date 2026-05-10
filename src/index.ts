import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { prompts } from "./db/schema.js";
import {
  EXPERT_QUOTE_PITCH_TYPE,
  EXPERT_QUOTE_PITCH_TEMPLATE,
  EXPERT_QUOTE_PITCH_VARIABLES,
} from "./lib/expert-quote-pitch-template.js";
import { apiKeyAuth } from "./middleware/auth.js";
import healthRoutes from "./routes/health.js";
import generateRoutes from "./routes/generate.js";
import statsRoutes from "./routes/stats.js";
import promptRoutes from "./routes/prompts.js";
import composeRoutes from "./routes/compose.js";
import submagicRoutes from "./routes/submagic.js";
import transferBrandRoutes from "./routes/transfer-brand.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3005;

// Middleware
app.use(cors());
app.use(express.json());

// Public routes (no API key required — used by Railway healthcheck)
app.use(healthRoutes);

// OpenAPI spec endpoint
app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: pnpm generate:openapi" });
  }
});

// API key auth — all routes below require valid X-Api-Key
app.use(apiKeyAuth);

// Protected routes
app.use(generateRoutes);
app.use(statsRoutes);
app.use(promptRoutes);
app.use(composeRoutes);
app.use(submagicRoutes);
app.use(transferBrandRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry error handler must be before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Fallback error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/**
 * Idempotently register platform-owned prompt templates at boot.
 * Inserts only if the type does not exist; never overwrites a tuned version.
 * To roll out a new revision, register it with a versioned type via PUT /prompts.
 */
async function registerPlatformTemplates() {
  const platformTemplates = [
    {
      type: EXPERT_QUOTE_PITCH_TYPE,
      prompt: EXPERT_QUOTE_PITCH_TEMPLATE,
      variables: EXPERT_QUOTE_PITCH_VARIABLES,
    },
  ];

  for (const tpl of platformTemplates) {
    const existing = await db.query.prompts.findFirst({
      where: eq(prompts.type, tpl.type),
    });
    if (existing) {
      console.log(`[content-generation-service] Platform template '${tpl.type}' already registered (skip).`);
      continue;
    }
    await db.insert(prompts).values({
      orgId: null,
      type: tpl.type,
      prompt: tpl.prompt,
      variables: tpl.variables,
    });
    console.log(`[content-generation-service] Registered platform template '${tpl.type}'.`);
  }
}

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      return registerPlatformTemplates();
    })
    .then(() => {
      app.listen(Number(PORT), "::", () => {
        console.log(`Content generation service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Boot failed:", err);
      process.exit(1);
    });
}

export default app;
