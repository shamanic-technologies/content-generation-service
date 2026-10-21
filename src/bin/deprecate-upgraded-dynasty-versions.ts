import { db, sql } from "../db/index.js";
import { deprecateUpgradedVersions } from "../lib/template-dynasty-query.js";

/**
 * One-shot backfill (TPL-DYNASTY-1021-CG3): every dynasty version that heads no dynasty becomes
 * Deprecated "Upgraded". Dry-run by default; `--apply --by <staff email>` writes. Compiled into
 * dist so it runs inside the container: `node dist/bin/deprecate-upgraded-dynasty-versions.js`.
 * Idempotent: a second apply deprecates nothing.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const byIndex = process.argv.indexOf("--by");
  const changedBy = byIndex > 0 ? process.argv[byIndex + 1]?.trim().toLowerCase() : undefined;
  if (apply && !changedBy) throw new Error("--apply needs --by <staff email>");

  const types = await deprecateUpgradedVersions(db, { changedBy: changedBy ?? "dry-run", dryRun: !apply });
  console.log(`${apply ? "deprecated" : "would deprecate"} ${types.length} template(s):`);
  for (const t of types) console.log(`  ${t}`);

  const [left] = await deprecateUpgradedVersions(db, { changedBy: "dry-run", dryRun: true }).then((r) => [r.length]);
  console.log(`still active non-head versions after this run: ${left}`);
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
