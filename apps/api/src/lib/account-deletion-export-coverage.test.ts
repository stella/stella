import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { ACCOUNT_DELETION_MANUAL_TABLES } from "@/api/lib/account-deletion-steps";
import { ACCOUNT_EXPORT_REGISTRY } from "@/api/lib/account-export/registry";

/**
 * Exported personal tables that account deletion does not list as a manual
 * step, each with the reason its rows do not outlive the account.
 */
const HANDLED_OUTSIDE_MANUAL_STEPS: Readonly<Record<string, string>> = {
  user: "The account row itself is anonymized and soft-deleted.",
  chat_messages: "Deleted with the chat threads the account owns.",
  chat_message_revisions: "Deleted with the chat messages they revise.",
  agent_skill_revisions:
    "Deleted with the personal skills they revise; team skill revisions are organization records.",
  legal_reader_answers:
    "Private reader questions and answers; their erasure is tracked separately.",
};

const exportedTableNames = Object.entries(ACCOUNT_EXPORT_REGISTRY)
  .filter(([, disposition]) => disposition.type === "exported")
  .map(([tableName]) => tableName);

const manualTableNames = new Set(
  ACCOUNT_DELETION_MANUAL_TABLES.map((table) => getTableConfig(table).name),
);

describe("account deletion export coverage", () => {
  test("every table the account export returns is erased or has a recorded disposition", () => {
    const unhandled = exportedTableNames.filter(
      (tableName) =>
        !manualTableNames.has(tableName) &&
        !Object.hasOwn(HANDLED_OUTSIDE_MANUAL_STEPS, tableName),
    );
    expect(unhandled).toEqual([]);
  });

  test("every recorded disposition names a table the account export returns", () => {
    const exported = new Set(exportedTableNames);
    expect(
      Object.keys(HANDLED_OUTSIDE_MANUAL_STEPS).filter(
        (tableName) => !exported.has(tableName),
      ),
    ).toEqual([]);
  });
});
