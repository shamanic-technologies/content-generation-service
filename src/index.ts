import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { registerPlatformTemplates } from "./lib/register-platform-templates.js";
import { apiKeyAuth } from "./middleware/auth.js";
import { requestLog } from "./middleware/request-log.js";
import healthRoutes from "./routes/health.js";
import generateRoutes from "./routes/generate.js";
import statsRoutes from "./routes/stats.js";
import promptRoutes from "./routes/prompts.js";
import promptAssignmentRoutes from "./routes/prompt-assignments.js";
import composeRoutes from "./routes/compose.js";
import submagicRoutes from "./routes/submagic.js";
import transferBrandRoutes from "./routes/transfer-brand.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3005;

/**
 * Inbound JSON ceiling. This is express's own default made explicit, so the
 * bound is visible next to the routes it protects rather than inherited.
 * Crossing it is a readable 413, not a parse failure surfaced as a 500.
 */
const JSON_BODY_LIMIT = "100kb";

// Middleware
app.use(cors());
// Logged before body parsing and before auth so the in-flight request is named
// even when it never reaches a handler (oversized body, bad key, unknown path).
app.use(requestLog);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

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
app.use(promptAssignmentRoutes);
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
  // body-parser rejects an oversized body with this type. Surface it as the 413
  // it is so the caller reads a real limit instead of an opaque 500.
  if ((err as { type?: string }).type === "entity.too.large") {
    console.error(
      `[content-generation-service] Request body over the ${JSON_BODY_LIMIT} limit: ${req.method} ${req.path}`
    );
    return res.status(413).json({
      error: `Request body exceeds the ${JSON_BODY_LIMIT} limit`,
      limit: JSON_BODY_LIMIT,
    });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

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
