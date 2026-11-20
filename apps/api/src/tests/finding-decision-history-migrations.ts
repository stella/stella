import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const DEFINES_FUNCTION =
  /FUNCTION public\.stella_document_review_finding_decision_history\(\)/u;

/**
 * Every migration that defines the finding decision history trigger's
 * function, oldest first: a test database installs all of them, so the
 * function a test runs is the one production runs, including any later
 * replacement, with no list to keep in step by hand.
 */
export const findingDecisionHistoryMigrations = (): string[] =>
  readdirSync(DRIZZLE_DIR)
    .filter((folder) => {
      const file = nodePath.join(DRIZZLE_DIR, folder, "migration.sql");
      return (
        existsSync(file) && DEFINES_FUNCTION.test(readFileSync(file, "utf-8"))
      );
    })
    .toSorted();

export const findingDecisionHistoryMigrationPath = (folder: string): string =>
  nodePath.join(DRIZZLE_DIR, folder, "migration.sql");
