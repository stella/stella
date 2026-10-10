import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkills,
  agentSkillResources,
  billingGuidelineFiles,
  billingDraftUserSettings,
  contacts,
  workspaces,
  organizationSettings,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { loadBillingDraftContext } from "./billing-drafts-context";

const today = Temporal.PlainDate.from("2026-10-09");
const clock = spyOn(Temporal.Now, "plainDateISO").mockReturnValue(today);
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

beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  await db.insert(billingDraftUserSettings).values([
    {
      userId: ids.userA1,
      consentAt: new Date("2026-10-01T12:00:00Z"),
      preference: "Use concise Czech narratives",
    },
    {
      userId: ids.userA2,
      consentAt: new Date("2026-10-02T12:00:00Z"),
      preference: "Colleague preference",
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
      path: "firm.md",
      kind: "knowledge",
      content: "Firm preamble\n# Narratives\nDescribe purpose",
      sizeBytes: 45,
    },
    {
      id: guidelineIds.client,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "client.md",
      kind: "knowledge",
      content: "# Codes\nUse task codes",
      sizeBytes: 22,
    },
    {
      id: guidelineIds.unselectedClient,
      organizationId: ids.orgA,
      skillId: skillA,
      path: "other-client.md",
      kind: "knowledge",
      content: "# Other client",
      sizeBytes: 14,
    },
    {
      id: guidelineIds.otherFirm,
      organizationId: ids.orgB,
      skillId: skillB,
      path: "other-firm.md",
      kind: "knowledge",
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
    .where(eq(billingDraftUserSettings.userId, ids.userA1));
});

afterAll(async () => {
  clock.mockRestore();
  await releaseTestDb();
});

const load = async (
  matterId = ids.wsA1,
  allowedMatterIds = [ids.wsA1, ids.wsA2],
) =>
  await loadBillingDraftContext({
    safeDb: asTestRaw<SafeDb>(
      createSafeDb(db, allowedMatterIds, ids.orgA, ids.userA1),
    ),
    organizationId: ids.orgA,
    userId: ids.userA1,
    body: {
      entries: [
        {
          matterId,
          date: today.toString(),
          timezone: "Europe/Prague",
          durationMinutes: 60,
          appNames: ["Editor"],
        },
      ],
    },
  });

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
    .where(eq(billingDraftUserSettings.userId, ids.userA1));
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
    fileName: "firm.md",
    sections: ["Preamble", "Narratives"],
  });
  expect(
    context.guidelines.find(({ fileId }) => fileId === guidelineIds.firm)
      ?.matterIds,
  ).toBeUndefined();
  expect(
    context.guidelines.find(({ fileId }) => fileId === guidelineIds.client),
  ).toMatchObject({
    fileName: "client.md",
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
      async (tx) => await tx.select().from(billingDraftUserSettings).limit(10),
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
          .where(eq(billingDraftUserSettings.userId, ids.userA2))
          .returning(),
    )
  ).unwrap();
  expect(changed).toEqual([]);
  const colleague = await db
    .select()
    .from(billingDraftUserSettings)
    .where(eq(billingDraftUserSettings.userId, ids.userA2))
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
          .where(eq(billingDraftUserSettings.userId, ids.userA1))
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
          .where(eq(billingDraftUserSettings.userId, ids.userA1))
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
