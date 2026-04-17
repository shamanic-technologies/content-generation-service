import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("CONTENT_GENERATION_SERVICE_DATABASE_URL is not set");
}

// Disable prepared statements when using Neon's connection pooler (PgBouncer)
// PgBouncer in transaction mode doesn't support prepared statements
const usePooler = connectionString.includes("pooler");
export const sql = postgres(connectionString, { prepare: !usePooler });
export const db = drizzle(sql, { schema });
