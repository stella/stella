import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The latest committed function is shared by embedded and service-backed PostgreSQL tests. */
export const readDecisionDocketFilingYearMigration = (): string => {
  const root = path.resolve(import.meta.dir, "../../drizzle");
  for (const directory of readdirSync(root)
    .filter((entry) => /^\d{14}_/u.test(entry))
    .toSorted()
    .toReversed()) {
    const migration = readFileSync(
      path.join(root, directory, "migration.sql"),
      "utf-8",
    );
    const declaration =
      /^CREATE(?: OR REPLACE)? FUNCTION public\.decision_docket_filing_year\(/mu.exec(
        migration,
      );
    if (declaration === null) {
      continue;
    }
    const end = migration.indexOf("$function$;", declaration.index);
    if (end === -1) {
      return panic("Filing-year migration has no function terminator");
    }
    return migration.slice(declaration.index, end + "$function$;".length);
  }
  return panic("Filing-year migration is missing");
};
