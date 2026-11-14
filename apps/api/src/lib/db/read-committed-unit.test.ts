import { expect, test } from "bun:test";

import { runReadCommittedUnit } from "./read-committed-unit";

const BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";
const timeout = new Error("canceling statement due to statement timeout");

const recordingSession = (query: () => Promise<readonly unknown[]>) => {
  const statements: string[] = [];
  return {
    statements,
    session: {
      execute: async (statement: string) => {
        statements.push(statement);
      },
      query,
    },
  };
};

test("a read committed unit commits its work", async () => {
  const { session, statements } = recordingSession(async () => [
    { isolation: "read committed" },
  ]);

  const unit = await runReadCommittedUnit(session, async () => {
    await session.execute("UPDATE gated_row SET value = 1");
    return 1;
  });

  expect(unit.isOk() && unit.value).toBe(1);
  expect(statements).toEqual([
    BEGIN,
    "UPDATE gated_row SET value = 1",
    "COMMIT",
  ]);
});

const failures = [
  {
    name: "the isolation query rejects",
    query: async () => {
      throw timeout;
    },
    work: async () => {},
  },
  {
    name: "the unit joined another isolation",
    query: async () => [{ isolation: "repeatable read" }],
    work: async () => {},
  },
  {
    name: "the work rejects",
    query: async () => [{ isolation: "read committed" }],
    work: async () => {
      throw timeout;
    },
  },
] as const;

for (const { name, query, work } of failures) {
  test(`a unit rolls back and returns an error when ${name}`, async () => {
    const { session, statements } = recordingSession(query);

    const unit = await runReadCommittedUnit(session, work);

    expect(unit.isErr()).toBe(true);
    expect(statements).toEqual([BEGIN, "ROLLBACK"]);
  });
}
