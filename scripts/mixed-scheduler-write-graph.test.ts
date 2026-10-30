import { expect, test } from "bun:test";

import { scanOrgWriteGraph } from "./root-connection-shapes";

const entry = "apps/api/src/lib/flow-entry.ts";
const owner = "apps/api/src/lib/db/recovery-bookkeeping/scheduler.ts";
const globalOwner = "apps/api/src/lib/db/global-system-work.ts";
const header = `import {rootDb} from "@/api/db/root"; import {schedulerJobs} from "@/api/db/schema"; import {withOrgScope} from "@/api/db/org-scope"; import {writeSchedulerBookkeeping} from "@/api/lib/db/recovery-bookkeeping/scheduler";`;
const scan = (body: string) =>
  scanOrgWriteGraph({
    sources: new Map([
      ["apps/api/src/db/root.ts", "export const rootDb = {};"],
      ["apps/api/src/db/org-scope.ts", "export const withOrgScope = () => {};"],
      [owner, "export function writeSchedulerBookkeeping(operation) {}"],
      [globalOwner, "export const runGlobalSystemWork = () => {};"],
      [entry, header + body],
    ]),
    rootDoorFiles: new Set([entry]),
    policyEntryFiles: new Set(),
    recoveryOwnerFiles: new Set(),
    orgTables: new Set(),
    globalTables: new Set(["schedulerJobs"]),
    sqlTables: new Map([["scheduler_jobs", "schedulerJobs"]]),
    schedulerWriteIntents: {
      table: "schedulerJobs",
      ownerFile: owner,
      globalOwnerFile: globalOwner,
      dispositions: new Map([
        ["upsert", "by-task"],
        ["checkpoint-slot", "organization"],
        ["platform-state", "platform"],
        ["platform-register-one-shot", "platform"],
      ]),
      taskOwnership: new Map([
        ["flow.run", "organization"],
        ["scheduler.noop", "platform"],
      ]),
      globalJobs: new Map([["flow-schedule-orphan-page", entry]]),
    },
  });

test("mixed scheduler rows require the typed owner even for a platform task", () => {
  for (const task of ["flow.run", "scheduler.noop"]) {
    expect(
      scan(
        `export const run = () => rootDb.insert(schedulerJobs).values({task:${JSON.stringify(task)}});`,
      ).hits,
    ).toHaveLength(1);
  }
});
test("organization scheduler writes retain their actual scoped caller", () => {
  expect(
    scan(
      `export const run=()=>withOrgScope({tx:rootDb,fn:(_,scoped)=>writeSchedulerBookkeeping({type:"upsert",ownership:"organization",db:scoped,values:{task:"flow.run"}})});`,
    ).hits,
  ).toEqual([]);
});
test("an ordinary object cannot construct the scheduler scope capability", () => {
  expect(() =>
    scan(
      `export const run=()=>writeSchedulerBookkeeping({type:"checkpoint-slot",db:{tx:rootDb}});`,
    ),
  ).toThrow(
    /organization scheduler intent requires its withOrgScope capability/iu,
  );
});
test("the platform task disposition cannot write an organization task", () => {
  expect(() =>
    scan(
      `export const run=()=>writeSchedulerBookkeeping({type:"platform-state",task:"flow.run",db:rootDb});`,
    ),
  ).toThrow(/scheduler task ownership/iu);
});
test("a typed platform intent retains its canonical task decision", () => {
  expect(
    scan(
      `export const run=()=>writeSchedulerBookkeeping({type:"platform-state",task:"scheduler.noop",db:rootDb});`,
    ).hits,
  ).toEqual([]);
});
test("unlisted scheduler write intents fail closed", () => {
  expect(() =>
    scan(
      `export const run=()=>writeSchedulerBookkeeping({type:"new-operation",db:rootDb});`,
    ),
  ).toThrow(/unclassified scheduler write intent/iu);
});
test("a scoped scheduler capability cannot escape in the callback result", () => {
  expect(() =>
    scan(
      `export const run=()=>withOrgScope({tx:rootDb,fn:(_,scoped)=>scoped});`,
    ),
  ).toThrow(/exports a transaction capability/iu);
});

test("a native scheduler intent cannot hide a callback in payload data", () => {
  expect(() =>
    scan(
      `export const run=()=>writeSchedulerBookkeeping({type:"platform-state",task:"scheduler.noop",db:rootDb,state:{type:"checkpoint",payload:{toJSON:()=>rootDb.delete(schedulerJobs)}}});`,
    ),
  ).toThrow(/closed scheduler intent cannot receive a callback/iu);
});

test("platform registration retains the ownership of its persisted task", () => {
  expect(() =>
    scan(
      `export const run=()=>writeSchedulerBookkeeping({type:"platform-register-one-shot",db:rootDb,values:{task:"flow.run"}});`,
    ),
  ).toThrow(/scheduler task ownership/iu);
});
