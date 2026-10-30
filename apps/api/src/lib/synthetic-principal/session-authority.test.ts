import { expect, expectTypeOf, test } from "bun:test";

import { rootDb, type Transaction } from "@/api/db/root";

import {
  readSyntheticSessionAuthority,
  type SyntheticSessionAuthorityReader,
} from "./session-authority";

test("scoped transactions cannot be used as authority readers", async () => {
  expectTypeOf<Transaction>().not.toExtend<SyntheticSessionAuthorityReader>();
  expect(
    await readSyntheticSessionAuthority(rootDb, {
      sessionId: null,
      userId: "unused-without-a-session",
    }),
  ).toBeNull();
});
