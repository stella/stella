import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { DESKTOP_RUNNER_PROTOCOL } from "@stll/api-contract/desktop-runner";
import { CASE_LAW_RESULTS_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";
import { createTestClock } from "@stll/test-kit";

import {
  desktopRunnerAppCalls,
  desktopRunnerRuns,
  desktopRunners,
} from "@/api/db/schema";
import {
  appCallArgumentsHash,
  MAX_APP_CALLS_PER_RUN,
  pairAppCall,
  recordAppCall,
} from "@/api/lib/desktop-runner/app-calls";
import type { DesktopRunnerDb, RunOwner } from "@/api/lib/desktop-runner/store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const ids = createTestIds();
const clock = createTestClock();
let db: TestDatabase;

const ownerA: RunOwner = { userId: ids.userA1, organizationId: ids.orgA };
const ownerOther: RunOwner = { userId: ids.userA2, organizationId: ids.orgA };

const seedRun = async (owner: RunOwner) => {
  const desktopId = Bun.randomUUIDv7();
  const deviceJkt = `jkt-${desktopId}`;
  const now = new Date(clock.now());
  await db.insert(desktopRunners).values({
    userId: owner.userId,
    organizationId: owner.organizationId,
    desktopId,
    deviceJkt,
    keyId: `key-${desktopId}`,
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-test",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    connectedAt: now,
    lastSeenAt: now,
  });
  const runId = Bun.randomUUIDv7();
  await db.insert(desktopRunnerRuns).values({
    runId,
    userId: owner.userId,
    organizationId: owner.organizationId,
    desktopId,
    deviceJkt,
    harness: "claude-code",
    harnessVersion: "2.1.309",
    workspaceIds: [],
    state: "running",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  });
  return runId;
};

const args = { query: "unfair dismissal", country: "CZ" };

const record = async (
  owner: RunOwner,
  runId: string,
  result: Record<string, unknown>,
  callArgs: Record<string, unknown> = args,
) =>
  await recordAppCall(runnerDb(), {
    owner,
    runId,
    toolName: "search_case_law",
    argumentsHash: appCallArgumentsHash(callArgs),
    resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
    result,
  });

const pair = async (
  owner: RunOwner,
  runId: string,
  toolCallId: string,
  callArgs: Record<string, unknown> = args,
  toolName = "search_case_law",
) =>
  await pairAppCall(runnerDb(), {
    owner,
    runId,
    toolName,
    argumentsHash: appCallArgumentsHash(callArgs),
    toolCallId,
  });

// SAFETY: the test database exposes the same Drizzle query and transaction
// APIs as the owner connection the ledger runs on.
const runnerDb = () => asTestRaw<DesktopRunnerDb>(db);

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
}, 30_000);
afterAll(releaseTestDb);

describe("the app call ledger of a local run", () => {
  test("hashes arguments by content, whatever their key order", () => {
    expect(appCallArgumentsHash({ a: 1, b: { c: [1, 2] } })).toBe(
      appCallArgumentsHash({ b: { c: [1, 2] }, a: 1 }),
    );
    expect(appCallArgumentsHash({ a: 1 })).not.toBe(
      appCallArgumentsHash({ a: 2 }),
    );
  });

  test("pairs reported calls with the server's answers in order, once each", async () => {
    const runId = await seedRun(ownerA);
    expect(await record(ownerA, runId, { page: 1 })).toBe(true);
    expect(await record(ownerA, runId, { page: 2 })).toBe(true);

    expect(await pair(ownerA, runId, "call-one")).toEqual({
      resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
      result: { page: 1 },
    });
    expect(await pair(ownerA, runId, "call-two")).toMatchObject({
      result: { page: 2 },
    });
    // A re-read of the run pairs the same call with the same answer.
    expect(await pair(ownerA, runId, "call-one")).toMatchObject({
      result: { page: 1 },
    });
    // A third report has no answer left to take.
    expect(await pair(ownerA, runId, "call-three")).toBeNull();
  });

  test("pairs nothing for a report the server never answered", async () => {
    const runId = await seedRun(ownerA);
    await record(ownerA, runId, { page: 1 });
    expect(
      await pair(ownerA, runId, "call-forged", { query: "something else" }),
    ).toBeNull();
    expect(
      await pair(
        ownerA,
        runId,
        "call-renamed",
        args,
        "read_case_law_citations",
      ),
    ).toBeNull();
    // The real call still finds its answer.
    expect(await pair(ownerA, runId, "call-real")).toMatchObject({
      result: { page: 1 },
    });
  });

  test("keeps another member's run out of reach both ways", async () => {
    const runId = await seedRun(ownerA);
    expect(await record(ownerOther, runId, { page: 1 })).toBe(false);
    await record(ownerA, runId, { page: 1 });
    expect(await pair(ownerOther, runId, "call-other")).toBeNull();
    expect(await pair(ownerA, runId, "call-own")).toMatchObject({
      result: { page: 1 },
    });
  });

  test("holds a bounded number of answers per run", async () => {
    const runId = await seedRun(ownerA);
    for (let index = 0; index < MAX_APP_CALLS_PER_RUN; index += 1) {
      expect(await record(ownerA, runId, { index }, { index })).toBe(true);
    }
    expect(await record(ownerA, runId, { index: "over" })).toBe(false);
    const rows = await db
      .select({ id: desktopRunnerAppCalls.id })
      .from(desktopRunnerAppCalls)
      .where(eq(desktopRunnerAppCalls.runId, runId));
    expect(rows.length).toBe(MAX_APP_CALLS_PER_RUN);
  });

  test("goes with the run", async () => {
    const runId = await seedRun(ownerA);
    await record(ownerA, runId, { page: 1 });
    await db
      .delete(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, runId));
    const rows = await db
      .select({ id: desktopRunnerAppCalls.id })
      .from(desktopRunnerAppCalls)
      .where(eq(desktopRunnerAppCalls.runId, runId));
    expect(rows).toEqual([]);
  });
});
