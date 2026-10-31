import { expect, expectTypeOf, test } from "bun:test";

import {
  ONLINE_INDEX_REPLACEMENTS,
  ONLINE_WORK_NAMES,
} from "./online-migrations";
import {
  DEPLOY_BLOCKING,
  FINALIZED,
  finalizedWork,
  type FinalizedWorkName,
  isMigrateReady,
  type MigrateReadyWorkName,
  ONLINE_WORK_LIFECYCLE,
  type OnlineWorkLifecycle,
  PENDING,
} from "./online-work-lifecycle";

// The production map's states change release by release, so the brand is
// proven on a fixed map of the same shape.
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
type IsTotal<Map> = [Map] extends [
  Record<keyof typeof ONLINE_WORK_LIFECYCLE, OnlineWorkLifecycle>,
]
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

test("migrate-ready work is deploy-blocking or finalized, never pending", () => {
  expect([PENDING, DEPLOY_BLOCKING, FINALIZED].map(isMigrateReady)).toEqual([
    false,
    true,
    true,
  ]);
  expectTypeOf<
    Admits<"contacts_org_external_uidx", MigrateReadyWorkName>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    Admits<"case_law_citations_doctrine_cited_idx", MigrateReadyWorkName>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    Admits<"contacts_external_ref_check", MigrateReadyWorkName>
  >().toEqualTypeOf<false>();
});

test("every registered work name needs a lifecycle entry", () => {
  expect(Object.keys(ONLINE_WORK_LIFECYCLE).toSorted()).toEqual(
    [...new Set(ONLINE_WORK_NAMES)].toSorted(),
  );
  const partial = {
    apikey_personal_owner_keyset_idx:
      ONLINE_WORK_LIFECYCLE.apikey_personal_owner_keyset_idx,
  } as const;
  expectTypeOf<IsTotal<typeof partial>>().toEqualTypeOf<false>();
  expectTypeOf<IsTotal<typeof ONLINE_WORK_LIFECYCLE>>().toEqualTypeOf<true>();
});

// Startup validation proves a retired index's replacements exist, so a
// finalized retirement over pending work would refuse every boot.
test("a finalized retirement waits for finalized replacements", () => {
  const states = new Map<string, OnlineWorkLifecycle["state"]>(
    Object.entries(ONLINE_WORK_LIFECYCLE).map(([name, { state }]) => [
      name,
      state,
    ]),
  );
  const early = ONLINE_INDEX_REPLACEMENTS.flatMap(
    ({ legacyName, replacementNames }) =>
      states.get(legacyName) === "finalized"
        ? replacementNames.flatMap((name) =>
            states.get(name) === "finalized"
              ? []
              : [`${legacyName} -> ${name}`],
          )
        : [],
  );
  expect(early).toEqual([]);
});
