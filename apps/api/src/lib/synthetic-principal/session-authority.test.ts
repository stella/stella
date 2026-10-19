import { expectTypeOf, test } from "bun:test";

import type { Transaction } from "@/api/db/root";

import type { SyntheticSessionAuthorityReader } from "./session-authority";

test("scoped transactions cannot be used as authority readers", () => {
  expectTypeOf<Transaction>().not.toExtend<SyntheticSessionAuthorityReader>();
});
