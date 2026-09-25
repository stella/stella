/**
 * An announcement's audience is read in the caller's scoped transaction. The
 * `member` policy is what admits the organization's members and keeps every
 * other organization's out, so these run under the membership-scoped factory
 * request authentication builds. The recipient rows themselves are written
 * through a separate seam, captured here rather than filed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { createPublishAnnouncementEndpoint } from "@/api/handlers/notifications/announce";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { listAnnouncementRecipients } from "@/api/lib/notifications";
import type { NewNotification } from "@/api/lib/notifications";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type AnnounceContext = Parameters<
  ReturnType<typeof createPublishAnnouncementEndpoint>["handler"]
>[0];

let testDb: TestDatabase;
let ids: TestIds;
/** A member of orgA with no matter membership at all. */
const coMemberWithoutMatter = mintAuthProviderId<"user">();
/** Was a member of orgA; the membership row has since been removed. */
const formerMember = mintAuthProviderId<"user">();

/**
 * orgA's current members: userA1 and userA2 (ordinary members), userAdmin
 * (owner, no matter membership), and the co-member added below. userA1 is also
 * a member of orgB; userB1 belongs to orgB only.
 */
let orgAMembers: SafeId<"user">[];

const readAudience = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
  read: (tx: Transaction) => Promise<{ userId: string }[]>,
): Promise<string[]> =>
  (
    await createMembershipScopedDb(testDb, {
      organizationId,
      serverValidatedWorkspaceIds: [],
      userId,
    })(async (tx) => await read(asTestRaw<Transaction>(tx)))
  )
    .map((row) => row.userId)
    .toSorted();

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  await testDb.insert(user).values([
    {
      id: coMemberWithoutMatter,
      name: "Co-member without a matter",
      email: `${coMemberWithoutMatter}@test.local`,
    },
    {
      id: formerMember,
      name: "Former member",
      email: `${formerMember}@test.local`,
    },
  ]);
  const formerMembershipId = mintAuthProviderIdValue();
  await testDb.insert(member).values([
    {
      id: mintAuthProviderIdValue(),
      organizationId: ids.orgA,
      userId: coMemberWithoutMatter,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: formerMembershipId,
      organizationId: ids.orgA,
      userId: formerMember,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  await testDb.delete(member).where(eq(member.id, formerMembershipId));

  orgAMembers = [
    ids.userA1,
    ids.userA2,
    ids.userAdmin,
    coMemberWithoutMatter,
  ].toSorted();
});

afterAll(async () => {
  await testDb.delete(user).where(eq(user.id, coMemberWithoutMatter));
  await testDb.delete(user).where(eq(user.id, formerMember));
  await releaseTestDb();
});

describe("announcement audience reader", () => {
  test("the policy, not the reader's WHERE, keeps other organizations' members out", async () => {
    const visible = await readAudience(
      ids.orgA,
      ids.userA2,
      async (tx) => await tx.select({ userId: member.userId }).from(member),
    );

    expect(visible).toEqual(orgAMembers);
  });

  test("reaches co-members without a shared matter, and no former or foreign member", async () => {
    const audience = await readAudience(
      ids.orgA,
      ids.userA2,
      async (tx) => await listAnnouncementRecipients(tx, ids.orgA, 100),
    );

    expect(audience).toEqual(orgAMembers);
    expect(audience).toContain(coMemberWithoutMatter);
    expect(audience).not.toContain(formerMember);
    expect(audience).not.toContain(ids.userB1);
  });

  test("a scope for one organization reads nothing of another's", async () => {
    const audience = await readAudience(
      ids.orgA,
      ids.userA2,
      async (tx) => await listAnnouncementRecipients(tx, ids.orgB, 100),
    );

    expect(audience).toEqual([]);
  });

  test("stops at the limit so the caller can detect an oversized audience", async () => {
    const audience = await readAudience(
      ids.orgA,
      ids.userA2,
      async (tx) =>
        await listAnnouncementRecipients(tx, ids.orgA, orgAMembers.length - 1),
    );

    expect(audience).toHaveLength(orgAMembers.length - 1);
  });
});

describe("announcement endpoint", () => {
  const announce = async (maxRecipients: number) => {
    const audited: AuditEvent[] = [];
    const filed: NewNotification[][] = [];
    const recordAuditEvent = async (_tx: unknown, event: AuditEvent) => {
      audited.push(event);
    };
    const identity = {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userA2,
    };
    const result = await createPublishAnnouncementEndpoint({
      getOperatorUserIds: () => ids.userA2,
      maxRecipients,
      fanOut: async (rows) => {
        filed.push([...rows]);
      },
    }).handler(
      asTestRaw<AnnounceContext>({
        body: { title: "Office closed Friday", announcementKey: "audience" },
        createAuditRecorder: () => recordAuditEvent,
        getAccessibleWorkspaces: async () => [],
        getActiveWorkspaceIds: async () => [],
        getWorkspaceAccess: async () => null,
        memberRole: { role: "member" },
        orgAIConfig: null,
        promptCachingEnabled: false,
        recordAuditEvent,
        request: new Request("https://example.test/v1/notifications/announce"),
        route: "/test/notifications/announce",
        safeDb: createMembershipSafeDb(testDb, identity),
        scopedDb: createMembershipScopedDb(testDb, identity),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA2 },
      }),
    );
    return { audited, filed, result };
  };

  test("files one row per current member and audits the recipient count", async () => {
    const { audited, filed, result } = await announce(orgAMembers.length);

    expect(result).toEqual({ recipientCount: orgAMembers.length });
    expect(filed).toHaveLength(1);
    expect(
      filed
        .at(0)
        ?.map((row) => row.userId)
        .toSorted(),
    ).toEqual(orgAMembers);
    expect(audited).toEqual([
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.ANNOUNCEMENT,
        resourceId: `announcement:${ids.orgA}:audience`,
        workspaceId: null,
        metadata: {
          title: "Office closed Friday",
          recipientCount: orgAMembers.length,
        },
      },
    ]);
  });

  test("refuses an audience one past the cap, before auditing or filing", async () => {
    const { audited, filed, result } = await announce(orgAMembers.length - 1);

    expect(result).toMatchObject({ code: 422 });
    expect(audited).toEqual([]);
    expect(filed).toEqual([]);
  });
});
