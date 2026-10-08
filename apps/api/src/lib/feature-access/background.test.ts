import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  contacts,
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import {
  findSignalsBackgroundActor,
  isBackgroundFeatureEnabled,
  loadBackgroundFeatureActors,
} from "@/api/lib/feature-access/background";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const tx = asTestRaw<Pick<Transaction, "select">>(db);
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();

beforeAll(async () => {
  await db.insert(organization).values({
    id: organizationId,
    name: "Background gates",
    slug: `background-${organizationId}`,
    createdAt: new Date(),
  });
  const ownerId = mintAuthProviderId<"user">();
  await db.insert(user).values({
    id: ownerId,
    name: "Fixture owner",
    email: `${ownerId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId: ownerId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Scout member",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Scout matter",
    reference: "SCOUT",
  });
  await db
    .insert(workspaceMembers)
    .values({ id: createSafeId<"workspaceMember">(), workspaceId, userId });
});
afterAll(releaseTestDb);

describe("background feature admission", () => {
  for (const featureId of ["signals", "flows"] as const) {
    for (const deploymentEnabled of [false, true]) {
      for (const enrolled of [false, true]) {
        test(`${featureId}: deployment=${String(deploymentEnabled)}, enrolled=${String(enrolled)}`, async () => {
          const flag =
            featureId === "signals" ? "FEATURE_SIGNALS" : "FEATURE_FLOWS";
          const previousFlag = env[flag];
          const restore = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          env[flag] = deploymentEnabled;
          try {
            await db
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, organizationId),
                  eq(featureEnrolments.featureId, featureId),
                ),
              );
            if (enrolled) {
              await db
                .insert(featureEnrolments)
                .values({ organizationId, userId, featureId });
            }
            expect(
              await isBackgroundFeatureEnabled({
                tx,
                organizationId,
                userId,
                featureId,
              }),
            ).toBe(deploymentEnabled && enrolled);
            const admitted = await loadBackgroundFeatureActors({
              tx,
              featureId,
              principals: [{ organizationId, userId }],
            });
            expect(admitted.get(organizationId)?.has(userId) === true).toBe(
              deploymentEnabled && enrolled,
            );
            if (featureId === "signals") {
              expect(
                await findSignalsBackgroundActor({
                  tx,
                  organizationId,
                  workspaceId,
                }),
              ).toBe(deploymentEnabled && enrolled ? userId : null);
            }
          } finally {
            env[flag] = previousFlag;
            restore();
          }
        });
      }
    }
  }

  test("scouts select the enrolled member rather than the first organization member", async () => {
    const otherUserId = mintAuthProviderId<"user">();
    await db.insert(user).values({
      id: otherUserId,
      name: "Not enrolled",
      email: `${otherUserId}@example.test`,
      emailVerified: true,
    });
    await db.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: otherUserId,
      role: "member",
      createdAt: new Date(0),
    });
    await db.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: otherUserId,
    });
    await db
      .insert(featureEnrolments)
      .values({ organizationId, userId, featureId: "signals" })
      .onConflictDoNothing();
    expect(
      await findSignalsBackgroundActor({ tx, organizationId, workspaceId }),
    ).toBe(userId);
  });
  test("an enrolled member of another private matter cannot replace this matter's admitted actor", async () => {
    const otherUserId = mintAuthProviderId<"user">();
    await db.insert(user).values({
      id: otherUserId,
      name: "Other matter member",
      email: `${otherUserId}@example.test`,
      emailVerified: true,
    });
    await db.insert(member).values({
      id: `0${Bun.randomUUIDv7()}`,
      organizationId,
      userId: otherUserId,
      role: "member",
      createdAt: new Date(0),
    });
    await db
      .insert(featureEnrolments)
      .values([
        { organizationId, userId: otherUserId, featureId: "signals" },
        { organizationId, userId, featureId: "signals" },
      ])
      .onConflictDoNothing();
    try {
      expect(
        await findSignalsBackgroundActor({ tx, organizationId, workspaceId }),
      ).toBe(userId);
    } finally {
      await db.delete(user).where(eq(user.id, otherUserId));
    }
  });

  test("client-matter admin access admits an enrolled actor without granting private-matter access", async () => {
    const contactId = createSafeId<"contact">();
    const clientMatterId = createSafeId<"workspace">();
    const privateMatterId = createSafeId<"workspace">();
    await db.insert(contacts).values({
      id: contactId,
      organizationId,
      type: "organization",
      displayName: "Test client",
    });
    await db.insert(workspaces).values([
      {
        id: clientMatterId,
        organizationId,
        clientId: contactId,
        name: "Client matter",
        reference: "CLIENT",
      },
      {
        id: privateMatterId,
        organizationId,
        name: "Private matter",
        reference: "PRIVATE",
      },
    ]);
    await db
      .insert(featureEnrolments)
      .values({ organizationId, userId, featureId: "signals" })
      .onConflictDoNothing();
    try {
      for (const role of CLIENT_MATTER_ADMIN_ROLES) {
        await db
          .update(member)
          .set({ role })
          .where(
            and(
              eq(member.organizationId, organizationId),
              eq(member.userId, userId),
            ),
          );
        expect(
          await findSignalsBackgroundActor({
            tx,
            organizationId,
            workspaceId: clientMatterId,
          }),
        ).toBe(userId);
        expect(
          await findSignalsBackgroundActor({
            tx,
            organizationId,
            workspaceId: privateMatterId,
          }),
        ).toBeNull();
      }
    } finally {
      await db
        .update(member)
        .set({ role: "member" })
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, userId),
          ),
        );
    }
    expect(
      await findSignalsBackgroundActor({
        tx,
        organizationId,
        workspaceId: clientMatterId,
      }),
    ).toBeNull();
  });
});
