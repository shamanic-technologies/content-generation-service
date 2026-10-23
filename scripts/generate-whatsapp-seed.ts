/**
 * Writes drizzle/0040_whatsapp_templates.sql from src/lib/whatsapp-templates.ts (WA-TEMPLATES-1023).
 * Run once: `npx tsx scripts/generate-whatsapp-seed.ts`. tests/unit/whatsapp-templates.test.ts pins
 * the migration to the module, so the two never drift.
 */
import { writeFileSync } from "fs";
import { buildWhatsAppSeedSql } from "../src/lib/whatsapp-seed-sql.js";

writeFileSync("drizzle/0040_whatsapp_templates.sql", buildWhatsAppSeedSql());
console.log("[content-gen] wrote drizzle/0040_whatsapp_templates.sql");
