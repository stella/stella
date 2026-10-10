import { Result } from "better-result";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import * as v from "valibot";

import { desktopMatterCandidatesResponseSchema } from "@stll/api-contract/desktop-time-entries";

import { user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  desktopTimeEntryBatches,
  featureEnrolments,
  timeEntries,
} from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  createDesktopTimeEntryBatchEndpoint,
  desktopBatchFingerprint,
} from "./batch";
import { createDesktopTimeEntryBatchStatusEndpoint } from "./batch-status";
import { createDesktopMatterCandidatesEndpoint } from "./candidates";
import { createDesktopTimeEntryEndpoint } from "./create";

setDefaultTimeout(30_000);

const testState = createTestState({ file: import.meta.path, config: env });
let testDb: TestDatabase;
let ids: TestIds;
const KEY = "cross-org-committed-batch";
const EMAIL = "dual-member@example.test";
const ENTRY = {
  dateWorked: "2026-10-09",
  timezoneId: "UTC",
  durationMinutes: 6,
  narrative: "Reviewed agreement",
  billable: false,
};

testState.beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  await testDb
    .update(user)
    .set({ emailVerified: true, email: EMAIL })
    .where(eq(user.id, ids.userA1));
  await testDb.insert(featureEnrolments).values(
    [ids.orgA, ids.orgB].map((organizationId) => ({
      organizationId,
      userId: ids.userA1,
      featureId: "time-billing" as const,
    })),
  );
  await testDb.insert(desktopTimeEntryBatches).values({
    organizationId: ids.orgB,
    userId: ids.userA1,
    idempotencyKey: KEY,
    status: "committed",
    requestFingerprint: desktopBatchFingerprint({
      idempotencyKey: KEY,
      entries: [{ matterId: ids.wsB1, ...ENTRY }],
    }),
    result: { entries: [{ id: ids.timeEntryB1, matterId: ids.wsB1 }] },
  });
});

testState.beforeAll(() => {
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [ids.orgA, ids.orgB].map((organizationId) => ({
      type: "member" as const,
      organizationId,
      email: EMAIL,
    })),
  });
});

afterAll(async () => {
  await releaseRlsFixture();
});

// Replace only credential verification; every feature/read/write runs through
// the production membership scope and real RLS policies. The seeded user is a
// member of both organizations and has matter membership in both.
const appForKey = (organizationId: SafeId<"organization">) => {
  const scopedDb = asTestRaw<ScopedDb>(
    createMembershipScopedDb(testDb, {
      organizationId,
      userId: ids.userA1,
      serverValidatedWorkspaceIds: [],
    }),
  );
  const deviceSigner = createDesktopDeviceSigner();
  const authorizeAccount = async (request: Request) => {
    const device = await deviceSigner;
    return Result.ok({
      consumedProof: await claimFixtureDeviceProof({
        request: await device.signRequest({
          request,
          credential: "fixture-credential",
        }),
        deviceJkt: device.deviceJkt,
        keyId: `desktop-key-${organizationId}`,
        credential: "fixture-credential",
      }),
      organizationId,
      userId: ids.userA1,
      keyId: `desktop-key-${organizationId}`,
      memberRole: sessionMemberRole("member"),
      scopedDb,
    });
  };
  const candidates = createDesktopMatterCandidatesEndpoint(authorizeAccount);
  const batch = createDesktopTimeEntryBatchEndpoint(authorizeAccount);
  const status = createDesktopTimeEntryBatchStatusEndpoint(authorizeAccount);
  const single = createDesktopTimeEntryEndpoint(authorizeAccount);
  return new Elysia()
    .get("/candidates", candidates.handler, {
      response: candidates.config.response,
    })
    .put("/batch", batch.handler, {
      body: batch.config.body,
      response: batch.config.response,
    })
    .put("/status", status.handler, {
      body: status.config.body,
      response: status.config.response,
    })
    .put("/single/:workspaceId", single.handler, {
      params: single.config.params,
      body: single.config.body,
      response: single.config.response,
    });
};

const put = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const storedRows = async () => ({
  entries: await testDb.select().from(timeEntries).orderBy(timeEntries.id),
  receipts: await testDb
    .select()
    .from(desktopTimeEntryBatches)
    .orderBy(
      desktopTimeEntryBatches.organizationId,
      desktopTimeEntryBatches.idempotencyKey,
    ),
});

test("org A desktop candidates exclude org B matters for a user belonging to both organizations", async () => {
  const a = await appForKey(ids.orgA).handle(
    new Request("http://localhost/candidates"),
  );
  const b = await appForKey(ids.orgB).handle(
    new Request("http://localhost/candidates"),
  );
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const bodyA = v.parse(desktopMatterCandidatesResponseSchema, await a.json());
  const bodyB = v.parse(desktopMatterCandidatesResponseSchema, await b.json());
  expect(bodyA.matters).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: ids.wsA1 })]),
  );
  expect(bodyB.matters).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: ids.wsB1 })]),
  );
  expect(bodyA.matters).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: ids.wsB1 })]),
  );
  expect(bodyB.matters).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: ids.wsA1 })]),
  );
});

test("org A desktop batch refuses org B matters and never replays an org B batch key", async () => {
  const before = await storedRows();
  const app = appForKey(ids.orgA);
  for (const idempotencyKey of ["cross-org-new-batch", KEY]) {
    const response = await app.handle(
      put("/batch", {
        idempotencyKey,
        entries: [{ matterId: ids.wsB1, ...ENTRY }],
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      message: "Matter not found",
    });
  }
  expect(await storedRows()).toEqual(before);
});

test("org A desktop status hides an org B batch key and fences only its own namespace", async () => {
  const before = await storedRows();
  const appA = appForKey(ids.orgA);
  const appB = appForKey(ids.orgB);
  const committed = await appB.handle(put("/status", { idempotencyKey: KEY }));
  expect(committed.status).toBe(200);
  const bodyB = await committed.json();
  expect(bodyB).toEqual({
    type: "committed",
    entries: [{ id: ids.timeEntryB1, matterId: ids.wsB1 }],
  });
  const response = await appA.handle(put("/status", { idempotencyKey: KEY }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ type: "cancelled" });
  expect(
    await (await appB.handle(put("/status", { idempotencyKey: KEY }))).json(),
  ).toEqual(bodyB);
  const after = await storedRows();
  expect(after.entries).toEqual(before.entries);
  expect(
    after.receipts.filter(({ organizationId }) => organizationId === ids.orgB),
  ).toEqual(before.receipts);
  expect(
    after.receipts.filter(({ organizationId }) => organizationId === ids.orgA),
  ).toEqual([
    expect.objectContaining({
      organizationId: ids.orgA,
      userId: ids.userA1,
      idempotencyKey: KEY,
      status: "cancelled",
      result: null,
    }),
  ]);
  const rejected = await appA.handle(
    put("/batch", {
      idempotencyKey: KEY,
      entries: [{ matterId: ids.wsA1, ...ENTRY }],
    }),
  );
  expect(rejected.status).toBe(409);
  expect(await storedRows()).toEqual(after);
});

test("org A desktop single create refuses an org B matter despite dual organization membership", async () => {
  const before = await storedRows();
  const response = await appForKey(ids.orgA).handle(
    put(`/single/${ids.wsB1}`, ENTRY),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ message: "Matter not found" });
  expect(await storedRows()).toEqual(before);
});
