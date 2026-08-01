import { describe, expect, test } from "bun:test";

import { runOnlineMigrations } from "./online-migrations";

const CREATE_INDEX_FRAGMENT = "CREATE INDEX CONCURRENTLY";
const REINDEX_FRAGMENT = "REINDEX INDEX CONCURRENTLY";
const REPORT_EXPORT_INDEX = "report_exports_workspace_requester_created_idx";
const CREDENTIAL_INDEX = "account_credential_singleton_uidx";

describe("online migrations", () => {
  test("accepts an already valid index without rebuilding it", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("creates a missing index online and verifies completion", async () => {
    const harness = createHarness({
      [REPORT_EXPORT_INDEX]: [undefined, true],
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  test("concurrently repairs an interrupted invalid build", async () => {
    const harness = createHarness({
      [CREDENTIAL_INDEX]: [false, true],
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${REINDEX_FRAGMENT} public."${CREDENTIAL_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  test("rejects a missing index required by a rewritten migration", async () => {
    const harness = createHarness({
      [CREDENTIAL_INDEX]: [undefined],
    });

    await expect(runOnlineMigrations(harness.pool)).rejects.toThrow(
      `Required migration index ${CREDENTIAL_INDEX} is missing`,
    );
    expect(harness.released()).toBe(true);
  });
});

type IndexValidity = boolean | undefined;
type IndexStates = Readonly<Record<string, IndexValidity[]>>;

const createHarness = (indexStates: IndexStates = {}) => {
  const statements: string[] = [];
  const indexOffsets = new Map<string, number>();
  let released = false;

  return {
    pool: {
      reserve: async () => ({
        execute: async (query: string) => {
          statements.push(query);
        },
        query: async (query: string, params: readonly unknown[] = []) => {
          statements.push(query);
          const indexName = params.at(1);
          if (typeof indexName !== "string") {
            throw new TypeError("Expected index name query parameter");
          }
          const offset = indexOffsets.get(indexName) ?? 0;
          const states = indexStates[indexName];
          const isValid = states ? states.at(offset) : true;
          indexOffsets.set(indexName, offset + 1);
          return isValid === undefined ? [] : [{ isValid }];
        },
        release: () => {
          released = true;
        },
      }),
    },
    released: () => released,
    statements,
  };
};

const indexOfStatement = (statements: string[], fragment: string): number =>
  statements.findIndex((statement) => statement.includes(fragment));
