import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
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

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`Content generation service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
