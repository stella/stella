import { Result } from "better-result";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import * as v from "valibot";

import type { DesktopBillingDraftSettingsRequest } from "@stll/api-contract/desktop-billing-drafts";
import {
  DESKTOP_BILLING_DRAFT_REFUSAL_CODE,
  desktopBillingDraftSettingsResponseSchema,
  desktopBillingDraftSettingsUpdateResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import { createTestState } from "@stll/test-state";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkills,
  auditLogs,
  billingDraftUserSettings,
  billingGuidelineFiles,
  organizationSettings,
} from "@/api/db/schema";
import { createMembershipScopedDb, createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { deploymentFeatureGateExcept } from "@/api/lib/deployment-feature-route";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import {
  billingDraftGateRefusal,
  readBillingDraftGate,
  readEffectiveDraftMode,
} from "./billing-draft-mode";
import type { readSettingsView } from "./billing-draft-settings";
import {
  consentWithdrawalException,
  createDesktopBillingDraftSettingsReadEndpoint,
  createDesktopBillingDraftSettingsUpdateEndpoint,
  writeOwnBillingDraftSettings,
} from "./billing-draft-settings";

const testState = createTestState({ file: import.meta.path, config: env });
const ids = createTestIds();
let db: Awaited<ReturnType<typeof getTestDb>>;
const firmFileId = createSafeId<"agentSkillResource">();
const clientFileId = createSafeId<"agentSkillResource">();

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [ids.orgA, ids.orgB].map((organizationId) => ({
      type: "organization" as const,
      organizationId,
    })),
  });
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  const skillA = createSafeId<"agentSkill">();
  await db.insert(agentSkills).values({
    id: skillA,
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    scope: "team",
    origin: "authored",
    slug: "billing-rules",
    name: "Billing rules",
    description: "Rules",
    contentHash: "a".repeat(64),
    body: "Rules",
  });
  await db.insert(agentSkillResources).values([
    {
      id: firmFileId,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "references/firm.md",
      content: "# Narratives",
      sizeBytes: 12,
    },
    {
      id: clientFileId,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "references/client.md",
      content: "# Codes",
      sizeBytes: 7,
    },
  ]);
});

beforeEach(async () => {
  const organizations = [ids.orgA, ids.orgB];
  await db
    .delete(billingDraftUserSettings)
    .where(inArray(billingDraftUserSettings.organizationId, organizations));
  await db
    .delete(billingGuidelineFiles)
    .where(inArray(billingGuidelineFiles.organizationId, organizations));
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "enabled" })
    .where(inArray(organizationSettings.organizationId, organizations));
  await db
    .delete(auditLogs)
    .where(inArray(auditLogs.organizationId, organizations));
});

afterAll(async () => {
  await releaseTestDb();
});

type WriteOptions = {
  userId?: SafeId<"user">;
  change: DesktopBillingDraftSettingsRequest;
  timeZone?: string;
};

/** One write through the caller's own RLS-scoped transaction, optionally
 * under a session TimeZone other than the one the revision was read in. */
const write = async ({ userId = ids.userA1, change, timeZone }: WriteOptions) =>
  (
    await createSafeDb(
      db,
      [],
      ids.orgA,
      userId,
    )(async (tx) => {
      if (timeZone !== undefined) {
        await tx.execute(sql`select set_config('TimeZone', ${timeZone}, true)`);
      }
      return await writeOwnBillingDraftSettings({
        tx: asTestRaw<Transaction>(tx),
        organizationId: ids.orgA,
        userId,
        change,
        recordAuditEvent: createAuditRecorder({
          organizationId: ids.orgA,
          userId,
          workspaceId: null,
          request: new Request("http://localhost/v1/desktop/billing-drafts"),
          server: null,
        }),
      });
    })
  ).unwrap();

const stored = async (userId = ids.userA1) =>
  (
    await db
      .select()
      .from(billingDraftUserSettings)
      .where(
        and(
          eq(billingDraftUserSettings.organizationId, ids.orgA),
          eq(billingDraftUserSettings.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);

const audited = async (userId = ids.userA1) =>
  await db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, ids.orgA),
        eq(auditLogs.resourceId, userId),
      ),
    )
    .limit(20);

test("a withdrawal applies after another device wrote since the caller read", async () => {
  const granted = await write({
    change: { type: "grant_consent", revision: null },
  });
  expect(granted?.consentAt).toBeInstanceOf(Date);
  const readByThisDevice = granted?.revision ?? null;
  const otherDevice = await write({
    change: {
      type: "set_preference",
      revision: readByThisDevice,
      preference: "Concise narratives",
    },
  });
  expect(otherDevice?.revision).not.toBe(readByThisDevice);

  const withdrawn = await write({ change: { type: "withdraw_consent" } });

  expect(withdrawn?.consentAt).toBeNull();
  expect(withdrawn?.revision).not.toBe(otherDevice?.revision);
  expect(await stored()).toMatchObject({
    consentAt: null,
    preference: "Concise narratives",
  });
  // The stale revision this device read cannot restore consent either.
  expect(
    await write({
      change: { type: "grant_consent", revision: readByThisDevice },
    }),
  ).toBeUndefined();
  expect((await stored())?.consentAt).toBeNull();
});

test("a withdrawal with no stored settings records a row without consent", async () => {
  expect(await stored(ids.userA2)).toBeUndefined();

  const withdrawn = await write({
    userId: ids.userA2,
    change: { type: "withdraw_consent" },
  });

  expect(withdrawn).toMatchObject({ consentAt: null, preference: null });
  expect(withdrawn?.revision).toEqual(expect.any(String));
  expect(await stored(ids.userA2)).toMatchObject({
    consentAt: null,
    preference: null,
  });
  expect(await audited(ids.userA2)).toMatchObject([
    {
      metadata: {
        settings: "personal-billing-drafts",
        consent: "revoked",
        preferenceChanged: false,
      },
    },
  ]);
});

test("a grant or preference change on a stale revision writes nothing", async () => {
  const first = await write({
    change: { type: "set_preference", revision: null, preference: "First" },
  });
  const second = await write({
    change: {
      type: "set_preference",
      revision: first?.revision ?? null,
      preference: "Second",
    },
  });
  expect(second?.preference).toBe("Second");
  const auditedBefore = (await audited()).length;

  for (const change of [
    { type: "grant_consent", revision: first?.revision ?? null },
    { type: "grant_consent", revision: null },
    {
      type: "set_preference",
      revision: first?.revision ?? null,
      preference: "Stale",
    },
    { type: "grant_consent", revision: "not a revision" },
    // Shaped like a revision, but no instant has this date or time: the
    // write refuses it like any stale revision instead of failing the cast.
    { type: "grant_consent", revision: "2026-02-30 10:00:00.123456+00" },
    { type: "grant_consent", revision: "2026-10-31 24:00:00+00" },
    {
      type: "set_preference",
      revision: "2026-13-01 10:00:00+01",
      preference: "Impossible",
    },
  ] satisfies DesktopBillingDraftSettingsRequest[]) {
    expect(await write({ change })).toBeUndefined();
  }

  expect(await stored()).toMatchObject({
    consentAt: null,
    preference: "Second",
  });
  expect(await audited()).toHaveLength(auditedBefore);
});

test("a revision read in one session time zone matches in any other", async () => {
  let revision =
    (
      await write({
        change: { type: "set_preference", revision: null, preference: "Kept" },
        timeZone: "UTC",
      })
    )?.revision ?? null;
  for (const timeZone of ["Europe/Prague", "America/New_York"]) {
    // The fixture reaches the fault: the stored instant prints differently
    // in this zone, so a text comparison would refuse a current revision.
    const printed = (
      await createSafeDb(
        db,
        [],
        ids.orgA,
        ids.userA1,
      )(async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', ${timeZone}, true)`);
        return await tx
          .select({
            text: sql<string>`${billingDraftUserSettings.updatedAt}::text`,
          })
          .from(billingDraftUserSettings)
          .where(eq(billingDraftUserSettings.userId, ids.userA1))
          .limit(1);
      })
    ).unwrap();
    expect(printed.at(0)?.text).not.toBe(revision);

    const granted = await write({
      change: { type: "grant_consent", revision },
      timeZone,
    });

    expect(granted?.consentAt).toBeInstanceOf(Date);
    revision = granted?.revision ?? null;
  }
});

type Caller = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** Whether the caller holds the time-billing enrolment. */
  enrolled?: boolean;
  /** Replaces the update's second read, the settings view. */
  readView?: typeof readSettingsView;
  /** Calls the update through the route's deployment gate while the
   * deployment is off, as production mounts it. */
  deploymentOff?: boolean;
};

/** One linked desktop calling the settings endpoints on the real HTTP core,
 * through its own membership-scoped database. */
const callSettings = async (
  { organizationId, userId, enrolled = true, readView, deploymentOff }: Caller,
  change?: DesktopBillingDraftSettingsRequest,
) => {
  const authorizeAccount = async (request: Request) => {
    const device = await createDesktopDeviceSigner();
    return Result.ok({
      featureAccessSnapshot: buildFeatureAccessSnapshot({
        organizationId,
        userId,
        identity: { email: `${userId}@example.test`, emailVerified: true },
        enrolments: enrolled
          ? [{ featureId: "time-billing", organizationId, userId }]
          : [],
      }),
      consumedProof: await claimFixtureDeviceProof({
        request: await device.signRequest({
          request,
          credential: "billing-settings-fixture",
        }),
        deviceJkt: device.deviceJkt,
        keyId: "linked-desktop",
        credential: "billing-settings-fixture",
      }),
      organizationId,
      userId,
      keyId: "linked-desktop",
      memberRole: sessionMemberRole("member"),
      scopedDb: asTestRaw<ScopedDb>(
        createMembershipScopedDb(db, {
          organizationId,
          userId,
          serverValidatedWorkspaceIds: [],
        }),
      ),
    });
  };
  await using server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes(
        {
          "/settings": {
            GET: createDesktopBillingDraftSettingsReadEndpoint(
              authorizeAccount,
            ),
            PUT: createDesktopBillingDraftSettingsUpdateEndpoint(
              authorizeAccount,
              readView === undefined ? {} : { readView },
            ),
          },
        },
        deploymentOff === true
          ? {
              middleware: [
                deploymentFeatureGateExcept(
                  "FEATURE_TIME_BILLING",
                  consentWithdrawalException,
                  { isEnabled: () => false },
                ),
              ],
            }
          : {},
      ),
    }),
  );
  const response = await server.fetch(
    new Request(
      "http://localhost/settings",
      change === undefined
        ? {}
        : {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(change),
          },
    ),
  );
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const settingsOf = (body: unknown) =>
  v.parse(desktopBillingDraftSettingsResponseSchema, body);

const rowOf = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) =>
  (
    await db
      .select()
      .from(billingDraftUserSettings)
      .where(
        and(
          eq(billingDraftUserSettings.organizationId, organizationId),
          eq(billingDraftUserSettings.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);

const gateOf = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) =>
  (
    await createSafeDb(
      db,
      [],
      organizationId,
      userId,
    )(
      async (tx) =>
        await readBillingDraftGate({
          tx: asTestRaw<Transaction>(tx),
          organizationId,
          userId,
        }),
    )
  ).unwrap();

const A1_IN_A = { organizationId: ids.orgA, userId: ids.userA1 };
const A2_IN_A = { organizationId: ids.orgA, userId: ids.userA2 };
const A1_IN_B = { organizationId: ids.orgB, userId: ids.userA1 };

test("an impossible settings revision answers 409 and changes nothing", async () => {
  const saved = await callSettings(A1_IN_A, {
    type: "set_preference",
    revision: null,
    preference: "Kept",
  });
  expect(saved.status).toBe(200);
  const before = await rowOf(ids.orgA, ids.userA1);
  for (const revision of [
    "2026-02-30 10:00:00.123456+00",
    "2026-10-31 24:00:00+00",
    "2026-10-31 10:00:00+16",
  ]) {
    const refused = await callSettings(A1_IN_A, {
      type: "grant_consent",
      revision,
    });
    expect({ revision, status: refused.status }).toEqual({
      revision,
      status: 409,
    });
  }
  expect(await rowOf(ids.orgA, ids.userA1)).toEqual(before);
});

test("a member without the feature can still withdraw consent, and change nothing else", async () => {
  const granted = await callSettings(A1_IN_A, {
    type: "grant_consent",
    revision: null,
  });
  expect(granted.status).toBe(200);
  const { revision } = v.parse(
    desktopBillingDraftSettingsUpdateResponseSchema,
    granted.body,
  );
  const before = await rowOf(ids.orgA, ids.userA1);
  expect(before?.consentAt).toBeInstanceOf(Date);
  const unenrolled = { ...A1_IN_A, enrolled: false };
  for (const change of [
    { type: "grant_consent", revision },
    { type: "set_preference", revision, preference: "Refused" },
  ] satisfies DesktopBillingDraftSettingsRequest[]) {
    expect((await callSettings(unenrolled, change)).status).toBe(403);
  }
  expect(await rowOf(ids.orgA, ids.userA1)).toEqual(before);
  expect((await callSettings(unenrolled)).status).toBe(403);

  const withdrawn = await callSettings(unenrolled, {
    type: "withdraw_consent",
  });

  expect(withdrawn.status).toBe(200);
  // Nothing is drafted for a caller without the feature.
  expect(withdrawn.body).toMatchObject({
    effectiveMode: "off",
    consent: "revoked",
    preference: null,
  });
  expect((await rowOf(ids.orgA, ids.userA1))?.consentAt).toBeNull();
});

test("with the deployment off, a withdrawal passes the gate and the route reads the same body", async () => {
  const granted = await callSettings(A1_IN_A, {
    type: "grant_consent",
    revision: null,
  });
  expect(granted.status).toBe(200);
  const off = { ...A1_IN_A, deploymentOff: true };
  const { revision } = v.parse(
    desktopBillingDraftSettingsUpdateResponseSchema,
    granted.body,
  );
  expect(
    (
      await callSettings(off, {
        type: "set_preference",
        revision,
        preference: "Refused",
      })
    ).status,
  ).toBe(404);

  const withdrawn = await callSettings(off, { type: "withdraw_consent" });

  expect(withdrawn.status).toBe(200);
  expect(withdrawn.body).toMatchObject({ consent: "revoked" });
  expect((await rowOf(ids.orgA, ids.userA1))?.consentAt).toBeNull();
});

test("a withdrawal stays committed and answers revoked when reading the settings view fails", async () => {
  expect(
    (await callSettings(A1_IN_A, { type: "grant_consent", revision: null }))
      .status,
  ).toBe(200);
  const failingView = async () =>
    await Promise.reject(new Error("Settings view unavailable"));
  const logs = installRecordingLogger();

  const withdrawn = await callSettings(
    { ...A1_IN_A, readView: failingView },
    { type: "withdraw_consent" },
  );

  logs.restore();
  expect(
    logs.records
      .filter(
        ({ message }) => message === "billing_draft_settings.view_read_failed",
      )
      .map(({ attributes }) => attributes),
  ).toMatchObject([
    { change: "withdraw_consent", "error.type": "UnhandledException" },
  ]);

  expect(withdrawn.status).toBe(200);
  const answer = v.parse(
    desktopBillingDraftSettingsUpdateResponseSchema,
    withdrawn.body,
  );
  expect(answer).toMatchObject({ consent: "revoked", effectiveMode: "off" });
  const committed = await rowOf(ids.orgA, ids.userA1);
  expect(committed?.consentAt).toBeNull();
  // The answer names the committed row's revision.
  expect(settingsOf((await callSettings(A1_IN_A)).body).revision).toBe(
    answer.revision,
  );
  // Any other change answers its committed row too, so the client's next
  // change carries the current revision instead of meeting a 409.
  const regranted = await callSettings(
    { ...A1_IN_A, readView: failingView },
    { type: "grant_consent", revision: answer.revision },
  );
  expect(regranted.status).toBe(200);
  const granted = v.parse(
    desktopBillingDraftSettingsUpdateResponseSchema,
    regranted.body,
  );
  expect(granted).toMatchObject({ consent: "granted", effectiveMode: "off" });
  expect((await rowOf(ids.orgA, ids.userA1))?.consentAt).toBeInstanceOf(Date);
  const preferred = await callSettings(A1_IN_A, {
    type: "set_preference",
    revision: granted.revision,
    preference: "Next change on the answered revision",
  });
  expect(preferred.status).toBe(200);
});

test("the effective mode follows the organization's switch and its firm guideline file", async () => {
  const modeOf = async () => settingsOf((await callSettings(A1_IN_A)).body);
  expect((await modeOf()).effectiveMode).toBe("plain");
  // A client file alone never switches guided drafting on.
  await db.insert(billingGuidelineFiles).values({
    organizationId: ids.orgA,
    resourceId: clientFileId,
    clientId: ids.contactA,
  });
  expect((await modeOf()).effectiveMode).toBe("plain");
  await db.insert(billingGuidelineFiles).values({
    organizationId: ids.orgA,
    resourceId: firmFileId,
    clientId: null,
  });
  expect((await modeOf()).effectiveMode).toBe("guided");
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "disabled" })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  expect((await modeOf()).effectiveMode).toBe("off");
  // The same switch refuses drafting itself, firm file or not.
  await db
    .delete(billingGuidelineFiles)
    .where(
      and(
        eq(billingGuidelineFiles.organizationId, ids.orgA),
        isNull(billingGuidelineFiles.clientId),
      ),
    );
  await callSettings(A1_IN_A, { type: "grant_consent", revision: null });
  expect(billingDraftGateRefusal(await gateOf(ids.orgA, ids.userA1))).toEqual(
    expect.objectContaining({
      status: 403,
      code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff,
    }),
  );
  const effective = (
    await createSafeDb(
      db,
      [],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await readEffectiveDraftMode({
          tx: asTestRaw<Transaction>(tx),
          organizationId: ids.orgA,
          organizationMode: "disabled",
        }),
    )
  ).unwrap();
  expect(effective).toBe("off");
});

test("one member's withdrawal, settings and drafting gate never read or change another's", async () => {
  // A1 belongs to both organizations, A2 only to A; all three consent.
  for (const [caller, preference] of [
    [A1_IN_A, "A1 in organization A"],
    [A2_IN_A, "A2 in organization A"],
    [A1_IN_B, "A1 in organization B"],
  ] as const) {
    expect(
      (await callSettings(caller, { type: "grant_consent", revision: null }))
        .status,
    ).toBe(200);
    const current = settingsOf((await callSettings(caller)).body);
    expect(
      (
        await callSettings(caller, {
          type: "set_preference",
          revision: current.revision,
          preference,
        })
      ).status,
    ).toBe(200);
  }
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "disabled" })
    .where(eq(organizationSettings.organizationId, ids.orgB));
  const untouched = {
    a2: await rowOf(ids.orgA, ids.userA2),
    a1InB: await rowOf(ids.orgB, ids.userA1),
  };

  const withdrawn = await callSettings(A1_IN_A, { type: "withdraw_consent" });

  expect(withdrawn.status).toBe(200);
  expect(withdrawn.body).toMatchObject({
    effectiveMode: "plain",
    consent: "revoked",
    preference: "A1 in organization A",
  });
  expect(await rowOf(ids.orgA, ids.userA2)).toEqual(untouched.a2);
  expect(await rowOf(ids.orgB, ids.userA1)).toEqual(untouched.a1InB);
  // Each caller reads only its own row, under its own organization's switch.
  expect(settingsOf((await callSettings(A2_IN_A)).body)).toMatchObject({
    effectiveMode: "plain",
    consent: "granted",
    preference: "A2 in organization A",
  });
  expect(settingsOf((await callSettings(A1_IN_B)).body)).toMatchObject({
    effectiveMode: "off",
    consent: "granted",
    preference: "A1 in organization B",
  });
  // Drafting reads the same gate: A1's withdrawal in A refuses only A1 in A,
  // and B's switch refuses A1 in B whatever A allows.
  expect(
    billingDraftGateRefusal(await gateOf(ids.orgA, ids.userA1))?.code,
  ).toBe(DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired);
  expect(
    billingDraftGateRefusal(await gateOf(ids.orgA, ids.userA2)),
  ).toBeUndefined();
  expect((await gateOf(ids.orgA, ids.userA2)).preference).toBe(
    "A2 in organization A",
  );
  expect(
    billingDraftGateRefusal(await gateOf(ids.orgB, ids.userA1))?.code,
  ).toBe(DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff);
  // A2's later change leaves A1's rows as they were.
  const a1Rows = {
    inA: await rowOf(ids.orgA, ids.userA1),
    inB: await rowOf(ids.orgB, ids.userA1),
  };
  expect(
    (await callSettings(A2_IN_A, { type: "withdraw_consent" })).status,
  ).toBe(200);
  expect(await rowOf(ids.orgA, ids.userA1)).toEqual(a1Rows.inA);
  expect(await rowOf(ids.orgB, ids.userA1)).toEqual(a1Rows.inB);
});
