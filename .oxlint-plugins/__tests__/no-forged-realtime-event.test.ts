import { expect, test } from "bun:test";

import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule";

const rule = "no-forged-realtime-event";

test("deletion builders own literal, named and aliased event construction in every source file", async () => {
  const source = [
    'import { REALTIME_EVENT_TYPE as Events, RESOURCE_CHANGE_TYPE as Changes } from "@stll/api-contract/realtime-events";',
    'const direct = { type: "resource.deleted", resource };',
    'const changed = { change: "deleted", resource };',
    "const named = { type: Events.RESOURCE_DELETED, resource };",
    "const kind = Changes.DELETED;",
    "const alias = kind;",
    "const changedAlias = { change: alias, resource };",
    "const { RESOURCE_DELETED: deleted } = Events;",
    "const destructured = { type: deleted, resource };",
    'const domain = { status: "deleted", resource };',
    'const domainChange = { change: "deleted", record };',
    "const built = buildResourceDeletedEvent(classified);",
  ].join("\n");
  for (const sourcePath of [
    "apps/api/src/arbitrary.ts",
    "apps/web/src/arbitrary.test.ts",
    "packages/example/src/arbitrary.tsx",
    "scripts/arbitrary.test.ts",
  ]) {
    expect(await lintSingleRule(rule, source, { sourcePath })).toEqual([
      2, 3, 4, 7, 9,
    ]);
  }
});

test("brand names and type assertions cannot forge trusted builder inputs", async () => {
  const source = [
    'import type { BuiltRealtimeEvent as Trusted } from "@stll/api-contract/realtime-events";',
    'const ownership = v.brand("ClassifiedEntityDeletionOwnership");',
    "const event = v.brand(`BuiltRealtimeEvent`);",
    "const cast = value as BuiltRealtimeEvent;",
    "const aliasedCast = value as Trusted;",
    "const asserted = <ClassifiedEntityDeletionOwnership>value;",
    "type Alias = Trusted;",
    "const localType = value as Alias;",
    "const fixture = 'const x = v.brand(\"BuiltRealtimeEvent\");';",
  ].join("\n");
  expect(
    await lintSingleRule(rule, source, {
      sourcePath: "apps/api/src/arbitrary.test.ts",
    }),
  ).toEqual([2, 3, 4, 5, 6, 8]);
});

test("only canonical source files grant brand ownership and only the contract builds events", async () => {
  const brand =
    'const ownership = v.brand("ClassifiedEntityDeletionOwnership");\nconst value = raw as BuiltRealtimeEvent;';
  for (const sourcePath of [
    "packages/api-contract/src/realtime-events.ts",
    "apps/api/src/lib/flows/visibility.ts",
  ]) {
    expect(await lintSingleRule(rule, brand, { sourcePath })).toEqual([]);
  }
  expect(
    await lintSingleRule(rule, brand, {
      sourcePath: "packages/other/src/realtime-events.ts",
    }),
  ).toEqual([1, 2]);
  expect(
    await lintSingleRule(
      rule,
      'const event = { type: "resource.deleted", resource };',
      { sourcePath: "packages/api-contract/src/realtime-events.ts" },
    ),
  ).toEqual([]);
  expect(
    await lintSingleRule(
      rule,
      'const event = { type: "resource.deleted", resource };',
      { sourcePath: "apps/api/src/lib/flows/visibility.ts" },
    ),
  ).toEqual([1]);
});

test("namespace imports, enum-object aliases and computed keys retain deletion provenance", async () => {
  const source = [
    'import * as Contract from "@stll/api-contract/realtime-events";',
    "const Events = Contract.REALTIME_EVENT_TYPE;",
    "const Changes = Contract.RESOURCE_CHANGE_TYPE;",
    "const { DELETED: kind } = Changes;",
    'const event = { type: Events["RESOURCE_DELETED"], resource };',
    "const changed = { change: kind, resource };",
    "const cast = value as Contract.BuiltRealtimeEvent;",
  ].join("\n");
  expect(await lintSingleRule(rule, source)).toEqual([5, 6, 7]);
});

test("a canonical owner does not exempt the next file in the same lint worker", async () => {
  const source = 'const event = { type: "resource.deleted", resource };';
  expect(
    await lintRuleAcrossFiles(rule, {
      "packages/api-contract/src/realtime-events.ts": source,
      "z-consumer.test.ts": source,
    }),
  ).toEqual({
    "packages/api-contract/src/realtime-events.ts": [],
    "z-consumer.test.ts": [1],
  });
});

test("named deleted-change constants remain guarded when resource arrives in a spread", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { RESOURCE_CHANGE_TYPE } from "@stll/api-contract/realtime-events";',
        "const event = { ...input, change: RESOURCE_CHANGE_TYPE.DELETED };",
        'const domain = { ...input, change: "deleted" };',
      ].join("\n"),
    ),
  ).toEqual([2]);
});
