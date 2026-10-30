import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { desktopBillingDraftRequestSchema } from "@stll/api-contract/desktop-billing-drafts";
import { Temporal } from "@stll/time";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkills,
  billingDraftUserSettings,
  billingGuidelineFiles,
  contacts,
  organizationSettings,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipScopedDb, createSafeDb } from "@/api/db/scoped";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

import { writeBillingDraftUserSettings } from "./billing-draft-settings";
import { loadBillingDraftContext } from "./billing-drafts-context";

const today = Temporal.PlainDate.from("2026-10-09");
const ids = createTestIds();
let db: Awaited<ReturnType<typeof getTestDb>>;
const historyIds = {
  today: createSafeId<"timeEntry">(),
  boundary: createSafeId<"timeEntry">(),
  expired: createSafeId<"timeEntry">(),
  future: createSafeId<"timeEntry">(),
  colleague: createSafeId<"timeEntry">(),
  otherMatter: createSafeId<"timeEntry">(),
  otherOrganization: createSafeId<"timeEntry">(),
};

const guidelineIds = {
  firm: createSafeId<"agentSkillResource">(),
  client: createSafeId<"agentSkillResource">(),
  unselectedClient: createSafeId<"agentSkillResource">(),
  otherFirm: createSafeId<"agentSkillResource">(),
};

// timeout: This setup creates the isolated PGlite schema and seeds authorized and foreign-tenant rows before any behavior test runs.
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  await db.insert(billingDraftUserSettings).values([
    {
      organizationId: ids.orgA,
      userId: ids.userA1,
      consentAt: new Date("2026-10-01T12:00:00Z"),
      preference: "Use concise Czech narratives",
    },
    {
      organizationId: ids.orgA,
      userId: ids.userA2,
      consentAt: new Date("2026-10-02T12:00:00Z"),
      preference: "Colleague preference",
    },
    {
      organizationId: ids.orgB,
      userId: ids.userB1,
      consentAt: new Date("2026-10-03T12:00:00Z"),
      preference: "Other organization preference",
    },
  ]);
  await db
    .update(workspaces)
    .set({ billingNarrativeLanguage: "cs" })
    .where(eq(workspaces.id, ids.wsA1));
  await db
    .update(contacts)
    .set({ timeBillingFormat: "ledes" })
    .where(eq(contacts.id, ids.contactA));
  const skillA = createSafeId<"agentSkill">();
  const skillB = createSafeId<"agentSkill">();
  await db.insert(agentSkills).values([
    {
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
    },
    {
      id: skillB,
      organizationId: ids.orgB,
      userId: ids.userB1,
      scope: "team",
      origin: "authored",
      slug: "billing-rules",
      name: "Other firm rules",
      description: "Rules",
      contentHash: "b".repeat(64),
      body: "Rules",
    },
  ]);
  await db.insert(agentSkillResources).values([
    {
      id: guidelineIds.firm,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "references/firm.md",
      content: "Firm preamble\n# Narratives\nDescribe purpose",
      sizeBytes: 45,
    },
    {
      id: guidelineIds.client,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "references/client.md",
      content: "# Codes\nUse task codes",
      sizeBytes: 22,
    },
    {
      id: guidelineIds.unselectedClient,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "references/other-client.md",
      content: "# Other client",
      sizeBytes: 14,
    },
    {
      id: guidelineIds.otherFirm,
      organizationId: ids.orgB,
      skillId: skillB,
      path: "references/other-firm.md",
      content: "# Other firm",
      sizeBytes: 12,
    },
  ]);
  await db.insert(billingGuidelineFiles).values([
    { organizationId: ids.orgA, resourceId: guidelineIds.firm, clientId: null },
    {
      organizationId: ids.orgA,
      resourceId: guidelineIds.client,
      clientId: ids.contactA,
    },
    {
      organizationId: ids.orgA,
      resourceId: guidelineIds.unselectedClient,
      clientId: ids.contactA2,
    },
    {
      organizationId: ids.orgB,
      resourceId: guidelineIds.otherFirm,
      clientId: null,
    },
  ]);
  const rows = [
    {
      id: historyIds.today,
      date: today,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
    },
    {
      id: historyIds.boundary,
      date: today.subtract({ days: 90 }),
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
    },
    {
      id: historyIds.expired,
      date: today.subtract({ days: 91 }),
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
    },
    {
      id: historyIds.future,
      date: today.add({ days: 1 }),
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
    },
    {
      id: historyIds.colleague,
      date: today,
      userId: ids.userA2,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
    },
    {
      id: historyIds.otherMatter,
      date: today,
      userId: ids.userA1,
      workspaceId: ids.wsA2,
      organizationId: ids.orgA,
    },
    {
      id: historyIds.otherOrganization,
      date: today,
      userId: ids.userB1,
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
    },
  ];
  await db.insert(timeEntries).values(
    rows.map(({ date, ...row }) => ({
      ...row,
      dateWorked: date.toString(),
      createdAt: new Date(`${date.toString()}T12:00:00Z`),
      timezoneId: "Europe/Prague",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(100),
      currency: "CZK",
      narrative: "Reviewed agreement",
    })),
  );
}, 120_000);

beforeEach(async () => {
  spyOn(Temporal.Now, "plainDateISO").mockReturnValue(today);
  await db
    .insert(billingGuidelineFiles)
    .values({
      organizationId: ids.orgA,
      resourceId: guidelineIds.firm,
      clientId: null,
    })
    .onConflictDoNothing();
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "enabled" })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await db
    .update(billingDraftUserSettings)
    .set({
      consentAt: new Date("2026-10-01T12:00:00Z"),
      preference: "Use concise Czech narratives",
    })
    .where(
      and(
        eq(billingDraftUserSettings.organizationId, ids.orgA),
        eq(billingDraftUserSettings.userId, ids.userA1),
      ),
    );
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await releaseTestDb();
});

const loadBody = async (
  body: unknown,
  allowedMatterIds = [ids.wsA1, ids.wsA2],
) =>
  await loadBillingDraftContext({
    safeDb: asTestRaw<SafeDb>(
      createSafeDb(db, allowedMatterIds, ids.orgA, ids.userA1),
    ),
    organizationId: ids.orgA,
    userId: ids.userA1,
    body: v.parse(desktopBillingDraftRequestSchema, body),
  });

const load = async (
  matterId = ids.wsA1,
  allowedMatterIds = [ids.wsA1, ids.wsA2],
) =>
  await loadBody(
    {
      entries: [
        {
          entryId: "selected-entry",
          matterId,
          date: today.toString(),
          timezone: "Europe/Prague",
          durationMinutes: 60,
          appNames: ["Editor"],
        },
      ],
    },
    allowedMatterIds,
  );

test("context includes only the caller's selected matter history inside the bounded 90-day window", async () => {
  const result = await load();
  expect(result.isOk()).toBe(true);
  const context = result.unwrap();
  expect(context.earlierEntries.map(({ id }) => id).toSorted()).toEqual(
    [historyIds.today, historyIds.boundary].toSorted(),
  );
  expect(
    context.earlierEntries.every(({ matterId }) => matterId === ids.wsA1),
  ).toBe(true);
  expect(context.preference).toBe("Use concise Czech narratives");
});

test("mixed-case duplicate matter UUIDs normalize before the scoped context query", async () => {
  const uppercaseMatterId = ids.wsA1.toUpperCase();
  const result = await loadBody({
    entries: [
      {
        entryId: "selected-entry-1",
        matterId: uppercaseMatterId,
        date: today.toString(),
        timezone: "Europe/Prague",
        durationMinutes: 30,
        appNames: ["Editor"],
      },
      {
        entryId: "selected-entry-2",
        matterId: ids.wsA1.toLowerCase(),
        date: today.toString(),
        timezone: "Europe/Prague",
        durationMinutes: 30,
        appNames: ["Editor"],
      },
    ],
  });

  expect(result.isOk()).toBe(true);
  const context = result.unwrap();
  expect(
    context.matters.filter(({ matterId }) => matterId === ids.wsA1),
  ).toHaveLength(1);
});

test("organization disablement prevents any AI continuation", async () => {
  await db
    .update(organizationSettings)
    .set({ aiBillingDraftsMode: "disabled" })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  const result = await load();
  let modelCalled = false;
  result.map(() => {
    modelCalled = true;
    return true;
  });
  expect(modelCalled).toBe(false);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      "organization enablement and personal consent",
    );
  }
});

test("revoked personal consent prevents any AI continuation", async () => {
  await db
    .update(billingDraftUserSettings)
    .set({ consentAt: null })
    .where(
      and(
        eq(billingDraftUserSettings.organizationId, ids.orgA),
        eq(billingDraftUserSettings.userId, ids.userA1),
      ),
    );
  const result = await load();
  let modelCalled = false;
  result.map(() => {
    modelCalled = true;
    return true;
  });
  expect(modelCalled).toBe(false);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      "organization enablement and personal consent",
    );
  }
});

test("an inaccessible selected matter is refused by scoped queries before any AI continuation", async () => {
  for (const matterId of [ids.wsA2, ids.wsB1]) {
    const result = await load(matterId, [ids.wsA1]);
    let modelCalled = false;
    result.map(() => {
      modelCalled = true;
      return true;
    });
    expect(modelCalled).toBe(false);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Selected matter is unavailable");
    }
  }
});

test("guideline context joins only firm and selected client files with rule sections and live billing metadata", async () => {
  const context = (await load()).unwrap();
  expect(context.guidelines.map(({ fileId }) => fileId).toSorted()).toEqual(
    [guidelineIds.firm, guidelineIds.client].toSorted(),
  );
  expect(
    context.guidelines.find(({ fileId }) => fileId === guidelineIds.firm),
  ).toMatchObject({
    fileName: "references/firm.md",
    sections: ["Preamble", "Narratives"],
  });
  expect(
    context.guidelines.find(({ fileId }) => fileId === guidelineIds.firm)
      ?.matterIds,
  ).toBeUndefined();
  expect(
    context.guidelines.find(({ fileId }) => fileId === guidelineIds.client),
  ).toMatchObject({
    fileName: "references/client.md",
    sections: ["Preamble", "Codes"],
    matterIds: [ids.wsA1],
  });
  expect(
    context.matters.find(({ matterId }) => matterId === ids.wsA1),
  ).toMatchObject({ narrativeLanguage: "cs", ledesEnabled: true });
  expect(
    context.matters.find(({ matterId }) => matterId === ids.wsA2)?.ledesEnabled,
  ).toBe(false);
});

test("personal consent and drafting preferences remain readable and editable only by their owner", async () => {
  const safeDb = createSafeDb(db, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1);
  const visible = (
    await safeDb(
      async (tx) =>
        await tx
          .select()
          .from(billingDraftUserSettings)
          .where(eq(billingDraftUserSettings.organizationId, ids.orgA))
          .limit(10),
    )
  ).unwrap();
  expect(visible.map(({ userId }) => userId)).toEqual([ids.userA1]);
  expect(visible.at(0)?.preference).toBe("Use concise Czech narratives");
  const changed = (
    await safeDb(
      async (tx) =>
        await tx
          .update(billingDraftUserSettings)
          .set({ preference: "Unauthorized change", consentAt: null })
          .where(
            and(
              eq(billingDraftUserSettings.organizationId, ids.orgA),
              eq(billingDraftUserSettings.userId, ids.userA2),
            ),
          )
          .returning(),
    )
  ).unwrap();
  expect(changed).toEqual([]);
  const colleague = await db
    .select()
    .from(billingDraftUserSettings)
    .where(
      and(
        eq(billingDraftUserSettings.organizationId, ids.orgA),
        eq(billingDraftUserSettings.userId, ids.userA2),
      ),
    )
    .limit(1);
  expect(colleague.at(0)?.preference).toBe("Colleague preference");
  expect(colleague.at(0)?.consentAt?.toISOString()).toBe(
    "2026-10-02T12:00:00.000Z",
  );
});

test("the owner can revoke and grant consent and change a personal preference through scoped writes", async () => {
  const safeDb = createSafeDb(db, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1);
  const revoked = (
    await safeDb(
      async (tx) =>
        await tx
          .update(billingDraftUserSettings)
          .set({ consentAt: null, preference: "Use shorter narratives" })
          .where(
            and(
              eq(billingDraftUserSettings.organizationId, ids.orgA),
              eq(billingDraftUserSettings.userId, ids.userA1),
            ),
          )
          .returning(),
    )
  ).unwrap();
  expect(revoked.at(0)?.consentAt).toBeNull();
  expect((await load()).isErr()).toBe(true);
  const granted = (
    await safeDb(
      async (tx) =>
        await tx
          .update(billingDraftUserSettings)
          .set({ consentAt: new Date("2026-10-09T12:00:00Z") })
          .where(
            and(
              eq(billingDraftUserSettings.organizationId, ids.orgA),
              eq(billingDraftUserSettings.userId, ids.userA1),
            ),
          )
          .returning(),
    )
  ).unwrap();
  expect(granted.at(0)?.consentAt?.toISOString()).toBe(
    "2026-10-09T12:00:00.000Z",
  );
  expect((await load()).unwrap().preference).toBe("Use shorter narratives");
});

test("billing guideline knowledge text remains editable only by firm managers", async () => {
  const memberDb = createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1);
  const refused = (
    await memberDb(
      async (tx) =>
        await tx
          .update(agentSkillResources)
          .set({ content: "Unauthorized rewrite" })
          .where(eq(agentSkillResources.id, guidelineIds.firm))
          .returning(),
    )
  ).unwrap();
  expect(refused).toEqual([]);
  const adminDb = createSafeDb(db, [ids.wsA1], ids.orgA, ids.userAdmin);
  const updated = (
    await adminDb(
      async (tx) =>
        await tx
          .update(agentSkillResources)
          .set({ content: "Firm preamble\n# Narratives\nDescribe purpose" })
          .where(eq(agentSkillResources.id, guidelineIds.firm))
          .returning({ id: agentSkillResources.id }),
    )
  ).unwrap();
  expect(updated).toEqual([{ id: guidelineIds.firm }]);
});

test("missing firm guidance refuses drafting even when selected client guidance is attached", async () => {
  await db
    .delete(billingGuidelineFiles)
    .where(
      and(
        eq(billingGuidelineFiles.organizationId, ids.orgA),
        isNull(billingGuidelineFiles.clientId),
      ),
    );
  const clientFiles = await db
    .select()
    .from(billingGuidelineFiles)
    .where(eq(billingGuidelineFiles.clientId, ids.contactA))
    .limit(10);
  expect(clientFiles.map(({ resourceId }) => resourceId)).toEqual([
    guidelineIds.client,
  ]);
  const result = await load();
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe(
      "A firm billing guideline file is required",
    );
  }
});

test("candidate matter names require the caller's own work and current access", async () => {
  const colleagueMatter = createSafeId<"workspace">();
  const ownActivityMatter = createSafeId<"workspace">();
  await db.insert(workspaces).values([
    {
      id: colleagueMatter,
      organizationId: ids.orgA,
      name: "Colleague matter",
      reference: "COLLEAGUE",
      status: "active",
    },
    {
      id: ownActivityMatter,
      organizationId: ids.orgA,
      name: "Own activity matter",
      reference: "OWN",
      status: "active",
    },
  ]);
  await db.insert(timeEntries).values({
    id: createSafeId<"timeEntry">(),
    organizationId: ids.orgA,
    userId: ids.userA2,
    workspaceId: colleagueMatter,
    dateWorked: today.toString(),
    timezoneId: "UTC",
    durationMinutes: 30,
    billedMinutes: 30,
    rateAtEntry: cents(100),
    currency: "CZK",
    narrative: "Colleague work",
  });
  const activityDb = asTestRaw<SafeDb>(
    createSafeDb(db, [ownActivityMatter], ids.orgA, ids.userA1),
  );
  (
    await activityDb(
      async (tx) =>
        await createAuditRecorder({
          organizationId: ids.orgA,
          userId: ids.userA1,
          workspaceId: ownActivityMatter,
          request: new Request("https://api.example.test/activity"),
          server: null,
        })(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: ownActivityMatter,
        }),
    )
  ).unwrap();
  const allowed = [ids.wsA1, ids.wsA2, colleagueMatter, ownActivityMatter];
  const context = (await load(ids.wsA1, allowed)).unwrap();
  expect(context.matters.map(({ matterId }) => matterId)).not.toContain(
    colleagueMatter,
  );
  expect(context.moveTargetMatterIds).not.toContain(colleagueMatter);
  expect(context.moveTargetMatterIds).toContain(ownActivityMatter);
  expect(context.moveTargetMatterIds.at(0)).toBe(ownActivityMatter);
  const restricted = (await load(ids.wsA1, [ids.wsA1])).unwrap();
  expect(restricted.matters.map(({ matterId }) => matterId)).toEqual([
    ids.wsA1,
  ]);
  expect(restricted.moveTargetMatterIds).toEqual([ids.wsA1]);
});

test("consent CAS refuses a delayed grant and replays after withdrawal, including first-write races", async () => {
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1),
  );
  const initial =
    (
      await db
        .select({
          revision: timestampCasToken(billingDraftUserSettings.updatedAt),
        })
        .from(billingDraftUserSettings)
        .where(
          and(
            eq(billingDraftUserSettings.organizationId, ids.orgA),
            eq(billingDraftUserSettings.userId, ids.userA1),
          ),
        )
        .limit(1)
    ).at(0) ?? panic("Missing personal settings");
  const save = async (body: {
    consent: "granted" | "revoked";
    revision: string | null;
  }) =>
    (
      await safeDb(
        async (tx) =>
          await writeBillingDraftUserSettings({
            tx,
            organizationId: ids.orgA,
            userId: ids.userA1,
            body,
            recordAuditEvent: createAuditRecorder({
              organizationId: ids.orgA,
              userId: ids.userA1,
              workspaceId: null,
              request: new Request("https://api.example.test/settings"),
              server: null,
            }),
          }),
      )
    ).unwrap();
  const withdrawn = await save({
    consent: "revoked",
    revision: initial.revision,
  });
  expect(withdrawn?.consentAt).toBeNull();
  expect(
    await save({ consent: "granted", revision: initial.revision }),
  ).toBeUndefined();
  expect(
    await save({ consent: "revoked", revision: initial.revision }),
  ).toBeUndefined();
  expect(await save({ consent: "granted", revision: null })).toBeUndefined();
  await db
    .delete(billingDraftUserSettings)
    .where(
      and(
        eq(billingDraftUserSettings.organizationId, ids.orgA),
        eq(billingDraftUserSettings.userId, ids.userA1),
      ),
    );
  const firstWithdrawal = await save({ consent: "revoked", revision: null });
  expect(firstWithdrawal?.consentAt).toBeNull();
  expect(firstWithdrawal?.revision).toBeString();
  expect(await save({ consent: "granted", revision: null })).toBeUndefined();
  const context = await load();
  expect(context.isErr()).toBe(true);
  expect(context.isErr() && context.error.message).toContain(
    "personal consent",
  );
});

test("recent matter context keeps its statement count and response bytes bounded at N and 10N", async () => {
  const matterIds = Array.from({ length: 200 }, () =>
    createSafeId<"workspace">(),
  );
  await db.insert(workspaces).values(
    matterIds.map((id) => ({
      id,
      organizationId: ids.orgA,
      name: "Recent matter",
      reference: id,
      status: "active" as const,
    })),
  );
  await db.insert(timeEntries).values(
    matterIds.map((workspaceId) => ({
      id: createSafeId<"timeEntry">(),
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceId,
      dateWorked: "2026-10-20",
      timezoneId: "UTC",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(100),
      currency: "CZK",
      narrative: "Own recent work",
    })),
  );
  const measure = async (count: number) => {
    let statements = 0;
    const measured = withQueryLogger(db, {
      logQuery: () => {
        statements += 1;
      },
    });
    const result = await loadBillingDraftContext({
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(
          measured,
          [ids.wsA1, ...matterIds.slice(0, count)],
          ids.orgA,
          ids.userA1,
        ),
      ),
      organizationId: ids.orgA,
      userId: ids.userA1,
      body: v.parse(desktopBillingDraftRequestSchema, {
        entries: [
          {
            entryId: "selected",
            matterId: ids.wsA1,
            date: today.toString(),
            timezone: "UTC",
            durationMinutes: 30,
            appNames: ["Editor"],
          },
        ],
      }),
    });
    const context = result.unwrap();
    expect(context.moveTargetMatterIds).toHaveLength(20);
    expect(context.matters).toHaveLength(21);
    return { statements, bytes: JSON.stringify(context.matters).length };
  };
  const small = await measure(20);
  const large = await measure(200);
  expect(small.statements).toBeGreaterThan(0);
  expect(large).toEqual(small);
});

test("revoking matter membership removes previously active move targets through live RLS", async () => {
  const scopedDb = createMembershipScopedDb(db, {
    organizationId: ids.orgA,
    userId: ids.userA1,
    serverValidatedWorkspaceIds: [],
  });
  const loadCurrent = async () =>
    await loadBillingDraftContext({
      safeDb: safeDbFromScoped(asTestRaw<ScopedDb>(scopedDb)),
      organizationId: ids.orgA,
      userId: ids.userA1,
      body: v.parse(desktopBillingDraftRequestSchema, {
        entries: [
          {
            entryId: "selected",
            matterId: ids.wsA1,
            date: today.toString(),
            timezone: "UTC",
            durationMinutes: 30,
            appNames: ["Editor"],
          },
        ],
      }),
    });
  expect((await loadCurrent()).unwrap().moveTargetMatterIds).toContain(
    ids.wsA2,
  );
  await db
    .delete(workspaceMembers)
    .where(eq(workspaceMembers.id, ids.memberA1wsA2));
  try {
    const context = (await loadCurrent()).unwrap();
    expect(context.matters.map(({ matterId }) => matterId)).not.toContain(
      ids.wsA2,
    );
    expect(context.moveTargetMatterIds).not.toContain(ids.wsA2);
  } finally {
    await db.insert(workspaceMembers).values({
      id: ids.memberA1wsA2,
      workspaceId: ids.wsA2,
      userId: ids.userA1,
    });
  }
});
