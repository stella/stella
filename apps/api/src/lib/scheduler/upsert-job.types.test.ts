import { expect, expectTypeOf, test } from "bun:test";

import type { OrgScopedTransaction, withOrgScope } from "@/api/db/org-scope";
import type { rootDb } from "@/api/db/root";
import type { ScopedTransaction } from "@/api/db/safe-db";
import { SCHEDULER_WRITE_INTENT_DISPOSITIONS } from "@/api/lib/db/recovery-bookkeeping/scheduler";
import type { writeSchedulerBookkeeping } from "@/api/lib/db/recovery-bookkeeping/scheduler";
import type { JsonObject } from "@/api/lib/json-value";

import type {
  upsertSchedulerJob,
  writePlatformSchedulerTaskState,
  writeSchedulerJobOperatorPause,
  writeSearchSemanticTimestampsState,
} from "./upsert-job";

type UpsertOptions = Parameters<typeof upsertSchedulerJob>[0];
type BookkeepingWriter = typeof writeSchedulerBookkeeping;
type PlatformOptions = Extract<UpsertOptions, { ownership: "platform" }>;
type PlatformStateOptions = Parameters<
  typeof writePlatformSchedulerTaskState
>[0];
type OrganizationOptions = Extract<
  UpsertOptions,
  { ownership: "organization" }
>;
type OrganizationBookkeeping = Extract<
  Parameters<BookkeepingWriter>[0],
  { type: "upsert"; ownership: "organization" }
>;
type ScopeCallback = Parameters<Parameters<typeof withOrgScope>[0]["fn"]>[1];
type RootDatabase = typeof rootDb;

test("flow scheduler writes require the scoped callback capability", () => {
  expectTypeOf<
    OrganizationOptions["db"]
  >().toEqualTypeOf<OrgScopedTransaction>();
  expectTypeOf<
    OrganizationBookkeeping["db"]
  >().toEqualTypeOf<OrgScopedTransaction>();
  expectTypeOf<ScopeCallback>().toEqualTypeOf<OrgScopedTransaction>();
  expectTypeOf<RootDatabase>().not.toExtend<OrganizationOptions["db"]>();
  expectTypeOf<ScopedTransaction>().not.toExtend<OrganizationOptions["db"]>();
  expectTypeOf<"flow.run">().toExtend<
    OrganizationOptions["definition"]["task"]
  >();
  expectTypeOf<"flow.run">().not.toExtend<
    PlatformOptions["definition"]["task"]
  >();
});

test("platform checkpoints exclude organization-owned task intents", () => {
  expectTypeOf<"flow.run">().not.toExtend<PlatformStateOptions["task"]>();
  expectTypeOf<"workObligations.attentionScout">().toExtend<
    PlatformStateOptions["task"]
  >();
  expectTypeOf<PlatformStateOptions["state"]>().toEqualTypeOf<
    | { type: "checkpoint"; payload: JsonObject | null }
    | { type: "retire" }
    | {
        type: "checkpoint-and-retire";
        payload: JsonObject | null;
      }
  >();
});

test("scheduler task-state writes have a platform disposition", () => {
  expect(SCHEDULER_WRITE_INTENT_DISPOSITIONS["platform-state"]).toBe(
    "platform",
  );
  expect(
    SCHEDULER_WRITE_INTENT_DISPOSITIONS["agent-client-storage-complete"],
  ).toBe("platform");
});

test("scheduler payloads contain data rather than serialization callbacks", () => {
  expectTypeOf<{ toJSON: () => string }>().not.toExtend<
    NonNullable<PlatformOptions["definition"]["payload"]>
  >();
  expectTypeOf<{
    type: "checkpoint";
    payload: { toJSON: () => string };
  }>().not.toExtend<PlatformStateOptions["state"]>();
});

test("scheduler pause writes expose only the operator pause state", () => {
  type PauseState = Parameters<
    typeof writeSchedulerJobOperatorPause
  >[0]["state"];
  expectTypeOf<PauseState>().toEqualTypeOf<
    | { type: "pause"; actor: string; reason: string; durationMinutes: number }
    | { type: "resume"; actor: string; reason: string }
  >();
  expect(SCHEDULER_WRITE_INTENT_DISPOSITIONS["operator-pause"]).toBe(
    "platform",
  );
});

test("semantic repair checkpoints expose only named state transitions", () => {
  type State = Parameters<
    typeof writeSearchSemanticTimestampsState
  >[0]["state"];
  expectTypeOf<State>().toMatchTypeOf<{ type: "complete" }>();
  expectTypeOf<{
    type: "arbitrary";
    payload: { toJSON: () => string };
  }>().not.toExtend<State>();
  expect(SCHEDULER_WRITE_INTENT_DISPOSITIONS["search-semantic-state"]).toBe(
    "platform",
  );
});
