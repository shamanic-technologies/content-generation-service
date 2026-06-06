import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Neon scale-to-zero cold-start: the first connection after idle hits a resuming compute.
// Node 20's happy-eyeballs gives each candidate address only 250ms
// (autoSelectFamilyAttemptTimeout), so the IPv4 connect to Neon times out (and the IPv6
// candidate is ENETUNREACH on most CI runners) → `AggregateError [ETIMEDOUT]` BEFORE the wake
// completes. Bump the per-address attempt to 5s so the IPv4 connect waits for the resume.
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const connectionString = process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("CONTENT_GENERATION_SERVICE_DATABASE_URL is not set");
}

// Disable prepared statements when using Neon's connection pooler (PgBouncer)
// PgBouncer in transaction mode doesn't support prepared statements
const usePooler = connectionString.includes("pooler");
export const sql = postgres(connectionString, { prepare: !usePooler });
export const db = drizzle(sql, { schema });
