import { expect, test } from "bun:test";

import { scanOrgWriteGraph } from "./root-connection-shapes";

const entry = "apps/api/src/lib/root-entry.ts";
const helper = "apps/api/src/lib/forward.ts";
const owner = "apps/api/src/lib/db/recovery-bookkeeping/claims.ts";
const root = "apps/api/src/db/root.ts";
const scope = "apps/api/src/db/org-scope.ts";
const client = "apps/api/src/db/sql-client.ts";
const scan = (sources: Readonly<Record<string, string>>, enrolled = true) =>
  scanOrgWriteGraph({
    sources: new Map(
      Object.entries({
        [root]: "export const rootDb = {};",
        [scope]: "export const withOrgScope = () => {};",
        [client]:
          "export const createDatabase = () => ({}); export const createSqlClient = () => ({});",
        ...(enrolled
          ? {
              [owner]:
                'import {flowRuns} from "@/api/db/schema"; export const write = tx => tx.update(flowRuns).set({status:"running"});',
            }
          : {}),
        ...sources,
      }),
    ),
    rootDoorFiles: new Set(),
    policyEntryFiles: new Set(),
    recoveryOwnerFiles: new Set(enrolled ? [owner] : []),
    orgTables: new Set(["flowRuns"]),
    globalTables: new Set(),
    sqlTables: new Map([["flow_runs", "flowRuns"]]),
  });
const forward = `import {write} from "@/api/lib/db/recovery-bookkeeping/claims"; export const forward = tx => write(tx);`;

test("a forwarding helper receives the scoped capability its caller passes", () => {
  const result = scan({
    [helper]: forward,
    [entry]: `import {rootDb} from "@/api/db/root"; import {withOrgScope} from "@/api/db/org-scope"; import {forward} from "./forward"; export const run = () => withOrgScope({tx:rootDb,fn: tx=>forward(tx)});`,
  });
  expect(result.hits).toEqual([]);
  expect(result.reachedRecoveryOwners).toEqual([owner]);
});

test("a helper called with scoped and privileged handles is checked under both", () => {
  const result = scan({
    [helper]: forward,
    [entry]: `import {rootDb} from "@/api/db/root"; import {withOrgScope} from "@/api/db/org-scope"; import {forward} from "./forward"; export const run = () => {withOrgScope({tx:rootDb,fn: tx=>forward(tx)}); return forward(rootDb);};`,
  });
  expect(result.hits.map(({ entry: calledFrom }) => calledFrom)).toEqual([
    entry,
  ]);
});

test("a helper that constructs its own raw database is independently a root", () => {
  const result = scan(
    {
      [helper]: `import {createDatabase} from "@/api/db/sql-client"; import {flowRuns} from "@/api/db/schema"; export const run = () => createDatabase({}).update(flowRuns).set({status:"running"});`,
    },
    false,
  );
  expect(result.analyzedEntries).toContain(helper);
  expect(result.hits).toHaveLength(1);
});

test("an enrolled helper with no privileged caller is refused", () => {
  expect(() => scan({ [helper]: forward })).toThrow(
    /recovery owner .* was not reached/iu,
  );
});

test("an unresolved caller cannot receive a privileged handle and helper", () => {
  expect(() =>
    scan({
      [helper]: forward,
      [entry]: `import {rootDb} from "@/api/db/root"; import {forward} from "./forward"; export const run = caller => caller(forward, rootDb);`,
    }),
  ).toThrow(/unresolved delegate .* receives a transaction or callable/iu);
});

test("reading an enrolled module does not analyze an uncalled write helper", () => {
  expect(() =>
    scan({
      [owner]:
        'import {flowRuns} from "@/api/db/schema"; export const read = () => 1; export const write = tx => tx.update(flowRuns).set({status:"running"});',
      [entry]:
        'import {rootDb} from "@/api/db/root"; import {read} from "@/api/lib/db/recovery-bookkeeping/claims"; export const run = () => {read(); return rootDb;};',
    }),
  ).toThrow(/not reached|unanalyzed/iu);
});
