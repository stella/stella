import { expectTypeOf, test } from "bun:test";

import type { OnlineWorkName } from "./online-migrations";
import {
  FINALIZED,
  type FinalizedWorkName,
  finalizedWork,
  ONLINE_WORK_LIFECYCLE,
  type OnlineWorkLifecycle,
  PENDING,
} from "./online-work-lifecycle";

// The production map holds no pending work yet, so the brand is proven on a
// map of the same shape.
const TEST_LIFECYCLE = {
  pending_work: PENDING,
  finalized_work: FINALIZED,
} as const satisfies Record<string, OnlineWorkLifecycle>;

type TestFinalizedWorkName = {
  [
    Name in keyof typeof TEST_LIFECYCLE
  ]: (typeof TEST_LIFECYCLE)[Name]["state"] extends "finalized" ? Name : never;
}[keyof typeof TEST_LIFECYCLE];

type Admits<Name, Admitted> = [Name] extends [Admitted] ? true : false;
type IsTotal<Map> = [Map] extends [Record<OnlineWorkName, OnlineWorkLifecycle>]
  ? true
  : false;

test("a finalized handle admits finalized work only", () => {
  expectTypeOf<
    Admits<"finalized_work", TestFinalizedWorkName>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    Admits<"pending_work", TestFinalizedWorkName>
  >().toEqualTypeOf<false>();
  expectTypeOf(
    finalizedWork("case_law_citations_doctrine_cited_idx"),
  ).toExtend<FinalizedWorkName>();
});

test("every registered work name needs a lifecycle entry", () => {
  const partial = {
    apikey_personal_owner_keyset_idx:
      ONLINE_WORK_LIFECYCLE.apikey_personal_owner_keyset_idx,
  } as const;
  expectTypeOf<IsTotal<typeof partial>>().toEqualTypeOf<false>();
  expectTypeOf<IsTotal<typeof ONLINE_WORK_LIFECYCLE>>().toEqualTypeOf<true>();
});
