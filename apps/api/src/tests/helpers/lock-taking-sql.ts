import { panic } from "better-result";

import {
  createPolicy,
  createUngatedTableGateForTests,
} from "../../db/online-ddl";
import type {
  LockTakingStatement,
  PolicyDefinition,
} from "../../db/online-ddl";

/** What a statement executes, read the only way a caller can: by running it. */
export const lockTakingSqlOf = async (
  statement: LockTakingStatement,
): Promise<string> => {
  const statements: string[] = [];
  await createUngatedTableGateForTests({
    execute: async (query) => {
      statements.push(query);
    },
    query: async () => [],
  }).run({
    target: { tableName: statement.tableName, name: "probe" },
    kind: "index_repair",
    work: async (session) => {
      await session.run(statement);
    },
  });
  return statements.at(0) ?? "";
};

const BLOCK = /^DO \$online_ddl\$ BEGIN (.*) END \$online_ddl\$$/u;

/**
 * The statements an ACCESS EXCLUSIVE block runs, without the lock budget it
 * sets first. The owner refuses `;` inside a statement, so it splits exactly.
 */
export const blockStatementsOf = async (
  statement: LockTakingStatement,
): Promise<string[]> => {
  const body = BLOCK.exec(await lockTakingSqlOf(statement))?.at(1);
  if (body === undefined) {
    return panic("Not an online DDL block");
  }
  const [budget, ...statements] = body
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (budget !== "SET LOCAL lock_timeout = '1s'") {
    return panic(`Unexpected online DDL block budget: ${budget}`);
  }
  return statements;
};

/** Each policy's CREATE POLICY statement, as a migration spells it. */
export const createPolicyStatementsOf = async (
  policies: readonly PolicyDefinition[],
): Promise<string[]> => {
  const statements: string[] = [];
  for (const policy of policies) {
    for (const statement of await blockStatementsOf(createPolicy(policy))) {
      statements.push(`${statement};`);
    }
  }
  return statements;
};
