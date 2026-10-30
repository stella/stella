import { expect, test } from "bun:test";

import { scanOrgWriteGraph } from "./root-connection-shapes";

const file = "apps/api/src/lib/entry.ts";
const scan = (body: string) =>
  scanOrgWriteGraph({
    sources: new Map([
      ["apps/api/src/db/root.ts", "export const rootDb={};"],
      [
        file,
        `import {rootDb} from "@/api/db/root"; import {flowRuns} from "@/api/db/schema"; ${body}`,
      ],
    ]),
    rootDoorFiles: new Set(),
    policyEntryFiles: new Set(),
    recoveryOwnerFiles: new Set(),
    orgTables: new Set(["flowRuns"]),
    globalTables: new Set(),
    sqlTables: new Map([["flow_runs", "flowRuns"]]),
  });
test("a native panic branch cannot produce a collection", () => {
  expect(
    scan(
      `import {panic as stop} from "better-result"; export const run = flag => {const rows = flag ? [rootDb] : stop("missing rows"); for(const tx of rows) tx.update(flowRuns).set({status:"running"});};`,
    ).hits,
  ).toHaveLength(1);
});
test("a native panic still evaluates its argument effects", () => {
  expect(
    scan(
      `import {panic} from "better-result"; export const run = () => panic("stopped", rootDb.update(flowRuns).set({status:"running"}));`,
    ).hits,
  ).toHaveLength(1);
});
test("a local function named panic retains its actual return value", () => {
  expect(
    scan(
      `const panic=()=>[rootDb]; export const run = () => {for(const tx of panic()) tx.update(flowRuns).set({status:"running"});};`,
    ).hits,
  ).toHaveLength(1);
});
