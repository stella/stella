import { describe, expect, test } from "bun:test";

import { runOnlineMigrations } from "./online-migrations";

const CREATE_INDEX_FRAGMENT = "CREATE INDEX CONCURRENTLY";
const DROP_INDEX_FRAGMENT = "DROP INDEX CONCURRENTLY";
const RECORD_COMPLETION_FRAGMENT =
  "INSERT INTO drizzle.__stella_online_migrations";

describe("online migrations", () => {
  test("records an already valid index without rebuilding it", async () => {
    const harness = createHarness([true, true]);

    await runOnlineMigrations(harness.pool);

    expect(indexOfStatement(harness.statements, DROP_INDEX_FRAGMENT)).toBe(-1);
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(
      indexOfStatement(harness.statements, RECORD_COMPLETION_FRAGMENT),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  test("creates a missing index online before recording completion", async () => {
    const harness = createHarness([undefined, true]);

    await runOnlineMigrations(harness.pool);

    expect(indexOfStatement(harness.statements, DROP_INDEX_FRAGMENT)).toBe(-1);
    expect(
      indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(harness.statements, RECORD_COMPLETION_FRAGMENT),
    ).toBeGreaterThan(
      indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT),
    );
    expect(harness.released()).toBe(true);
  });

  test("repairs an interrupted invalid build before recording completion", async () => {
    const harness = createHarness([false, true]);

    await runOnlineMigrations(harness.pool);

    const dropIndex = indexOfStatement(harness.statements, DROP_INDEX_FRAGMENT);
    const createIndex = indexOfStatement(
      harness.statements,
      CREATE_INDEX_FRAGMENT,
    );
    const recordCompletion = indexOfStatement(
      harness.statements,
      RECORD_COMPLETION_FRAGMENT,
    );
    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dropIndex);
    expect(recordCompletion).toBeGreaterThan(createIndex);
    expect(harness.released()).toBe(true);
  });
});

type IndexValidity = boolean | undefined;

const createHarness = (indexStates: IndexValidity[]) => {
  const statements: string[] = [];
  let indexState = 0;
  let released = false;

  return {
    pool: {
      reserve: async () => ({
        execute: async (query: string) => {
          statements.push(query);
        },
        query: async (query: string) => {
          statements.push(query);
          const isValid = indexStates.at(indexState);
          indexState += 1;
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
