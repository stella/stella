import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  contacts,
  entities,
  infoSoudTrackedCases,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { VOCABULARY_LIMITS } from "@/api/handlers/workspaces/vocabulary/candidates";
import readVocabulary from "@/api/handlers/workspaces/vocabulary/get";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

type SeedVocabularyOptions = { db: GatedTestDb; size: number };

export const seedMatterVocabulary = async ({
  db,
  size,
}: SeedVocabularyOptions) => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const deniedWorkspaceId = createSafeId<"workspace">();
  const foreignWorkspaceId = createSafeId<"workspace">();
  const clientId = createSafeId<"contact">();
  const personId = createSafeId<"contact">();
  const companyId = createSafeId<"contact">();
  const foreignContactId = createSafeId<"contact">();
  await db.insert(organization).values(
    [organizationId, otherOrganizationId].map((id) => ({
      id,
      slug: id,
      name: "Vocabulary fixture",
      createdAt: new Date(),
    })),
  );
  await db.insert(user).values({
    id: userId,
    name: "Žofia Šťastná",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  await db.insert(contacts).values([
    {
      id: clientId,
      organizationId,
      type: "person",
      displayName: "Ľuboš Říha",
      firstName: "Ľuboš",
      lastName: "Říha",
    },
    {
      id: personId,
      organizationId,
      type: "person",
      displayName: "Žofia Šťastná",
      firstName: "Žofia",
      lastName: "Šťastná",
    },
    {
      id: companyId,
      organizationId,
      type: "organization",
      displayName: "Čučoriedka, s. r. o.",
      organizationName: "Čučoriedka, s. r. o.",
    },
    {
      id: foreignContactId,
      organizationId: otherOrganizationId,
      type: "organization",
      displayName: "Čučoriedka, s. r. o.",
    },
  ]);
  await db.insert(workspaces).values([
    {
      id: workspaceId,
      organizationId,
      clientId,
      name: "Zastoupení Ľuboše Říhy",
      reference: "ŘÍHA-2026",
      lastActivityAt: new Date("2026-10-01Z"),
    },
    {
      id: deniedWorkspaceId,
      organizationId,
      name: "Nepřístupná věc",
      reference: "DENIED",
    },
    {
      id: foreignWorkspaceId,
      organizationId: otherOrganizationId,
      clientId: foreignContactId,
      name: "Zastoupení Ľuboše Říhy",
      reference: "FOREIGN",
    },
  ]);
  await db
    .insert(workspaceMembers)
    .values({ id: createSafeId<"workspaceMember">(), workspaceId, userId });
  await db.insert(workspaceContacts).values([
    {
      id: createSafeId<"workspaceContact">(),
      organizationId,
      workspaceId,
      contactId: personId,
      role: "witness",
    },
    {
      id: createSafeId<"workspaceContact">(),
      organizationId,
      workspaceId,
      contactId: companyId,
      role: "opposing_party",
    },
    {
      id: createSafeId<"workspaceContact">(),
      organizationId: otherOrganizationId,
      workspaceId: foreignWorkspaceId,
      contactId: foreignContactId,
      role: "opposing_party",
    },
  ]);
  await db.insert(infoSoudTrackedCases).values({
    id: createSafeId<"infoSoudTrackedCase">(),
    workspaceId,
    courtCode: "NS",
    spisZn: "23 C 42/2026",
  });
  await db.insert(entities).values([
    ...Array.from({ length: VOCABULARY_LIMITS.perKind }, (_, index) => ({
      id: createSafeId<"entity">(),
      workspaceId,
      name: `Vyjádření Žofie Šťastné ${String(index).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
      updatedAt: new Date("2026-10-02Z"),
    })),
    ...Array.from({ length: size }, (_, index) => ({
      id: createSafeId<"entity">(),
      workspaceId,
      name: `Starší podání ${index}`,
      createdAt: new Date("2020-01-01Z"),
    })),
    {
      id: createSafeId<"entity">(),
      workspaceId: deniedWorkspaceId,
      name: "Neveřejné vyjádření Žofie Šťastné",
    },
    {
      id: createSafeId<"entity">(),
      workspaceId: foreignWorkspaceId,
      name: "Cizí vyjádření Žofie Šťastné",
    },
    {
      id: createSafeId<"entity">(),
      workspaceId,
      kind: "folder",
      name: "Složka",
    },
    { id: createSafeId<"entity">(), workspaceId, kind: "task", name: "Úkol" },
  ]);
  const scopedDb = createMembershipScopedDb(markRlsDatabase(db), {
    organizationId,
    userId,
    serverValidatedWorkspaceIds: [],
  });
  return {
    db,
    organizationId,
    otherOrganizationId,
    userId,
    workspaceId,
    deniedWorkspaceId,
    foreignWorkspaceId,
    scopedDb,
    cleanup: async () => {
      for (const id of [organizationId, otherOrganizationId]) {
        await db.delete(workspaces).where(eq(workspaces.organizationId, id));
        await db.delete(contacts).where(eq(contacts.organizationId, id));
        await db.delete(organization).where(eq(organization.id, id));
      }
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type VocabularyFixture = Awaited<ReturnType<typeof seedMatterVocabulary>>;

export const matterVocabularyScalingScenario = {
  name: "matter vocabulary",
  definition: readVocabulary,
  measure: async (fixture: VocabularyFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readVocabulary.handler(
        createTestHandlerContext<Parameters<typeof readVocabulary.handler>[0]>({
          scopedDb: fixture.scopedDb,
          safeDb: NO_DB,
          audit: NO_AUDIT,
          workspaceId: fixture.workspaceId,
          session: { activeOrganizationId: fixture.organizationId },
          user: { id: fixture.userId },
        }),
      );
      if (response instanceof HttpStatusResponse) {
        panic("Vocabulary scaling requires a successful matter read");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.candidates.length,
      };
    }),
};
