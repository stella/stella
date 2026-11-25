import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_PROTOCOL,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  desktopRunnerServerMessageSchema,
} from "@stll/api-contract/desktop-runner";
import { createTestClock } from "@stll/test-kit";

import {
  chatBrowserSiteGrants,
  desktopRunnerCommands,
  desktopRunnerRuns,
  desktopRunners,
} from "@/api/db/schema";
import { createDesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerDoorbell } from "@/api/lib/desktop-runner/doorbell";
import type {
  ChatRunSession,
  DesktopRunnerDb,
  RunHolder,
  RunOwner,
} from "@/api/lib/desktop-runner/store";
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

const owner: RunOwner = { userId: ids.userA1, organizationId: ids.orgA };
const colleague: RunOwner = { userId: ids.userA2, organizationId: ids.orgA };
const elsewhere: RunOwner = { userId: ids.userB1, organizationId: ids.orgB };

const LIBRARY = "https://fixture-library.test";
const ARCHIVE = "https://fixture-archive.test";
const COURT = "https://records.fixture-court.test:8443";
const HARNESS_VERSION = "0.48.0";
const MODEL = "model-large";

// SAFETY: the test database exposes the same Drizzle query and transaction
// APIs as the owner connection the runner's store runs on.
const runnerDb = () => asTestRaw<DesktopRunnerDb>(db);

const rings: RunHolder[] = [];
const doorbell: DesktopRunnerDoorbell = {
  ring: (holder) => {
    rings.push(holder);
  },
  listen: async () => await Promise.resolve(async () => undefined),
};

const control = (maxCommandsPerRun?: number) =>
  createDesktopRunnerControl({
    db: runnerDb(),
    doorbell,
    now: () => new Date(clock.now()),
    ...(maxCommandsPerRun === undefined
      ? {}
      : { limits: { maxCommandsPerRun } }),
  });

/** A computer of `of` the API counts as connected, with Codex ready. */
const seedComputer = async (of: RunOwner) => {
  const desktopId = Bun.randomUUIDv7();
  const sessionId = Bun.randomUUIDv7();
  const now = new Date(clock.now());
  await db.insert(desktopRunners).values({
    userId: of.userId,
    organizationId: of.organizationId,
    desktopId,
    deviceJkt: `jkt-${desktopId}`,
    keyId: `key-${desktopId}`,
    sessionId,
    instanceId: "api-test",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [
      {
        id: "codex",
        state: "ready",
        version: HARNESS_VERSION,
        capabilities: ["approvals", "interrupt"],
        approvalModes: ["ask"],
        models: [{ id: MODEL, label: "Large model" }],
      },
    ],
    linkedFolders: [],
    connectedAt: now,
    lastSeenAt: now,
  });
  return { desktopId, sessionId };
};

/** Start a run of `of` on `desktopId`; the run is assigned, an open state. */
const startRun = async (of: RunOwner, desktopId: string) => {
  const outcome = (
    await control().startRun({
      owner: of,
      desktopId,
      harness: "codex",
      harnessVersion: HARNESS_VERSION,
      model: MODEL,
      reasoningEffort: null,
      approvals: "ask",
      browserSiteGrants: [],
      session: { type: "fresh" } as const satisfies ChatRunSession,
      instructions: "Summarize the matter.",
      messages: [{ role: "user", content: "Summarize the matter." }],
      attachments: [],
      mcp: { serverName: "stella", url: "https://api.example.test/mcp" },
      workspaceIds: [],
      linkedFolderId: null,
    })
  ).unwrap();
  return outcome.type === "assigned"
    ? outcome.runId
    : panic(`the run was not assigned: ${outcome.type}`);
};

const disconnect = async (desktopId: string) => {
  await db
    .update(desktopRunners)
    .set({ connection: "disconnected" })
    .where(eq(desktopRunners.desktopId, desktopId));
};

const finish = async (runId: string) => {
  await db
    .update(desktopRunnerRuns)
    .set({ state: "finished", outcome: "completed" })
    .where(eq(desktopRunnerRuns.runId, runId));
};

const allow = async (of: RunOwner, origins: readonly string[]) => {
  await db
    .insert(chatBrowserSiteGrants)
    .values(
      origins.map((origin) => ({
        organizationId: of.organizationId,
        userId: of.userId,
        origin,
      })),
    )
    .onConflictDoNothing();
};

/** Each test starts from members who allow no website. */
const allowNone = async () => {
  await db
    .delete(chatBrowserSiteGrants)
    .where(
      inArray(chatBrowserSiteGrants.userId, [
        owner.userId,
        colleague.userId,
        elsewhere.userId,
      ]),
    );
};

const revoke = async (of: RunOwner, origin: string) => {
  await db
    .delete(chatBrowserSiteGrants)
    .where(
      and(
        eq(chatBrowserSiteGrants.organizationId, of.organizationId),
        eq(chatBrowserSiteGrants.userId, of.userId),
        eq(chatBrowserSiteGrants.origin, origin),
      ),
    );
};

/** Every `run.site_grants` the runs hold, as the desktop is sent them. */
const siteGrantsOf = async (runIds: readonly string[]) =>
  (
    await db
      .select({
        runId: desktopRunnerCommands.runId,
        commandKey: desktopRunnerCommands.commandKey,
        payload: desktopRunnerCommands.payload,
      })
      .from(desktopRunnerCommands)
      .where(
        and(
          inArray(desktopRunnerCommands.runId, [...runIds]),
          eq(desktopRunnerCommands.kind, "run.site_grants"),
        ),
      )
      .orderBy(asc(desktopRunnerCommands.id))
  ).map(({ runId, commandKey, payload }) => ({
    runId,
    commandKey,
    message: v.parse(desktopRunnerServerMessageSchema, payload),
  }));

const pushed = async (of: RunOwner, maxCommandsPerRun?: number) =>
  (await control(maxCommandsPerRun).pushSiteGrants({ owner: of })).unwrap();

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
}, 30_000);
afterAll(releaseTestDb);
beforeEach(allowNone);

describe("the member's website approvals reach their open runs", () => {
  test("each open run of the member is queued the whole set once, under one revision; no other run is", async () => {
    await allow(owner, [LIBRARY, ARCHIVE]);
    await allow(colleague, [COURT]);
    const online = await seedComputer(owner);
    const away = await seedComputer(owner);
    const first = await startRun(owner, online.desktopId);
    const second = await startRun(owner, online.desktopId);
    const waiting = await startRun(owner, away.desktopId);
    await disconnect(away.desktopId);
    const done = await startRun(owner, online.desktopId);
    await finish(done);
    const theirs = await startRun(
      colleague,
      (await seedComputer(colleague)).desktopId,
    );
    const otherOrganization = await startRun(
      elsewhere,
      (await seedComputer(elsewhere)).desktopId,
    );
    rings.splice(0);

    const outcome = await pushed(owner);

    expect(outcome.origins).toEqual([ARCHIVE, LIBRARY]);
    expect(new Set(outcome.queued)).toEqual(new Set([first, second, waiting]));
    expect(outcome.full).toEqual([]);
    const queued = await siteGrantsOf([
      first,
      second,
      waiting,
      done,
      theirs,
      otherOrganization,
    ]);
    expect(new Set(queued.map(({ runId }) => runId))).toEqual(
      new Set([first, second, waiting]),
    );
    const revision = queued.at(0)?.commandKey ?? panic("nothing was queued");
    for (const { runId, commandKey, message } of queued) {
      expect(commandKey).toBe(revision);
      expect(message).toEqual({
        type: DESKTOP_RUNNER_SERVER_MESSAGE.runSiteGrants,
        runId,
        revision,
        origins: [ARCHIVE, LIBRARY],
      });
    }
    // The open socket holding both runs is rung once; a computer that is
    // away receives the set when it reconnects.
    expect(rings).toEqual([
      { sessionId: online.sessionId, instanceId: "api-test" },
    ]);
  });

  test("a newer set replaces the one a run holds, and a revoke reaches it as a smaller set", async () => {
    await allow(owner, [LIBRARY]);
    const { desktopId } = await seedComputer(owner);
    const runId = await startRun(owner, desktopId);
    const before = await pushed(owner);
    expect(before.origins).toEqual([LIBRARY]);

    await allow(owner, [COURT]);
    await pushed(owner);
    const grown = await siteGrantsOf([runId]);
    expect(grown.map(({ message }) => message)).toMatchObject([
      { origins: [LIBRARY, COURT].toSorted() },
    ]);

    await revoke(owner, LIBRARY);
    await revoke(owner, COURT);
    await pushed(owner);
    const shrunk = await siteGrantsOf([runId]);
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0]?.message).toMatchObject({ origins: [] });
    expect(shrunk[0]?.commandKey).not.toBe(grown[0]?.commandKey);
  });

  test("a run whose other commands fill its cap keeps the set it holds and is reported", async () => {
    await allow(owner, [LIBRARY]);
    const { desktopId } = await seedComputer(owner);
    const runId = await startRun(owner, desktopId);
    // Its `run.start` and one set fit a cap of two commands.
    const held = await pushed(owner, 2);
    expect(held.queued).toContain(runId);
    const kept = await siteGrantsOf([runId]);
    expect(kept).toHaveLength(1);

    expect((await control().interruptRun({ owner, runId })).unwrap()).toEqual({
      type: "queued",
    });
    await allow(owner, [ARCHIVE]);
    const full = await pushed(owner, 2);
    expect(full.full).toContain(runId);
    expect(full.queued).not.toContain(runId);
    expect(await siteGrantsOf([runId])).toEqual(kept);
  });
});
