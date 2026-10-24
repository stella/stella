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
const lockTakingSqlOf = async (
  statement: LockTakingStatement,
): Promise<string> => {
  const statements: string[] = [];
  await createUngatedTableGateForTests({
    execute: async (query) => {
      statements.push(query);
      await Promise.resolve();
    },
    query: async () => await Promise.resolve([]),
  }).run({
    target: { tableName: statement.tableName, name: "probe" },
    kind: "index_repair",
    work: async (session) => {
      await session.run(statement);
    },
  });
  return statements.at(1) ?? panic("Gated statement emitted no SQL");
};

const BLOCK = /^DO \$online_ddl\$ BEGIN (.*) END \$online_ddl\$$/u;

/**
 * The statements an ACCESS EXCLUSIVE block runs. The owner refuses `;`
 * inside a statement, so it splits exactly.
 */
export const blockStatementsOf = async (
  statement: LockTakingStatement,
): Promise<string[]> => {
  const body = BLOCK.exec(await lockTakingSqlOf(statement))?.at(1);
  if (body === undefined) {
    return panic("Not an online DDL block");
  }
  return body
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
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
