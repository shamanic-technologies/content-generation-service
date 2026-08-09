import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Node 20's happy-eyeballs gives each candidate address only 250ms
// (autoSelectFamilyAttemptTimeout), so a host that answers on IPv4 but is slow to accept, with
// an IPv6 candidate that is ENETUNREACH, fails as `AggregateError [ETIMEDOUT]` before the IPv4
// connect ever completes. Bump the per-address attempt to 5s. (Originally for Neon's
// scale-to-zero resume; kept because it costs nothing and only ever widens a connect window.)
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const connectionString = process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("CONTENT_GENERATION_SERVICE_DATABASE_URL is not set");
}

// Disable prepared statements behind a PgBouncer-style pooler: in transaction mode it does not
// support them. A direct connection (the self-hosted Postgres, and the CI container) keeps them.
const usePooler = connectionString.includes("pooler");
export const sql = postgres(connectionString, { prepare: !usePooler });
export const db = drizzle(sql, { schema });
