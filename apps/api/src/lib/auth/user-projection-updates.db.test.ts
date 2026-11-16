import { runWithTransaction } from "@better-auth/core/context";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { createUserProjectionUpdateHook } from "@/api/lib/auth/user-projection-updates";
import {
  ACCOUNT_MEMBERSHIP_PAGE_SIZE,
  listAccountMembershipPage,
} from "@/api/lib/db/account-row";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let database: TestDatabase;
const users: string[] = [];
const organizations: string[] = [];
beforeAll(async () => {
  database = await getTestDb();
});
afterAll(async () => {
  await deleteOrganizationsForTest(database, organizations);
  if (users.length > 0) {
    await database.delete(user).where(inArray(user.id, users));
  }
  await releaseTestDb();
});

const createFixture = async (
  notification: "working" | "read-failure" | "publish-failure" = "working",
  membershipCount = 2,
) => {
  const userId = mintAuthProviderIdValue();
  const otherUserId = mintAuthProviderIdValue();
  users.push(userId, otherUserId);
  await database.insert(user).values([
    { id: userId, name: "Before", email: `${userId}@projection.test` },
    { id: otherUserId, name: "Other", email: `${otherUserId}@projection.test` },
  ]);
  const ownOrganizations = Array.from({ length: membershipCount }, () =>
    mintAuthProviderIdValue(),
  );
  const foreignOrganization = mintAuthProviderIdValue();
  const created = [...ownOrganizations, foreignOrganization];
  organizations.push(...created);
  await database.insert(organization).values(
    created.map((id) => ({
      id,
      name: id,
      slug: id,
      createdAt: new Date("2026-11-01T00:00:00Z"),
    })),
  );
  await database.insert(member).values(
    created.map((organizationId) => ({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: organizationId === foreignOrganization ? otherUserId : userId,
      role: "owner",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    })),
  );
  const emitted: { organizationId: string; resource: string }[] = [];
  const observed: unknown[] = [];
  const failure = new APIError("SERVICE_UNAVAILABLE", {
    message: "Notification unavailable",
  });
  let refuse = false;
  const hook = createUserProjectionUpdateHook({
    readMembershipPage: async (options) => {
      if (notification === "read-failure") {
        throw failure;
      }
      return await listAccountMembershipPage({
        ...options,
        database: asTestRaw<typeof rootDb>(database),
      });
    },
    publish: (organizationId, resource) => {
      if (notification === "publish-failure") {
        throw failure;
      }
      emitted.push({ organizationId, resource });
    },
    observe: (error) => {
      observed.push(error);
    },
  });
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "user-projection-test-secret-long-enough-for-auth",
    database: drizzleAdapter(
      asTestRaw<typeof rootDb>(database),
      AUTH_DATABASE_ADAPTER_OPTIONS,
    ),
    databaseHooks: {
      user: {
        update: {
          before: async () => {
            if (refuse) {
              throw new APIError("FORBIDDEN", { message: "Update refused" });
            }
          },
          after: hook,
        },
      },
    },
  });
  const context = await auth.$context;
  return {
    context,
    userId,
    ownOrganizations,
    foreignOrganization,
    emitted,
    observed,
    failure,
    refuse: () => {
      refuse = true;
    },
    name: async () =>
      (
        await database
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1)
      ).at(0)?.name,
  };
};

test("a committed profile update announces all membership pages and no unrelated organization", async () => {
  const fixture = await createFixture(
    "working",
    ACCOUNT_MEMBERSHIP_PAGE_SIZE + 1,
  );
  await runWithTransaction(fixture.context.adapter, async () => {
    await fixture.context.internalAdapter.updateUser(fixture.userId, {
      name: "After",
    });
    expect(fixture.emitted).toEqual([]);
  });
  expect(await fixture.name()).toBe("After");
  expect(
    fixture.emitted.map(({ organizationId }) => organizationId).toSorted(),
  ).toEqual(fixture.ownOrganizations.toSorted());
  expect(
    fixture.emitted.every(({ resource }) => resource === RESOURCE_TYPE.USER),
  ).toBe(true);
  expect(
    fixture.emitted.some(
      ({ organizationId }) => organizationId === fixture.foreignOrganization,
    ),
  ).toBe(false);
  expect(fixture.observed).toEqual([]);
});

test("rollback and auth refusal emit no user projection announcement", async () => {
  const fixture = await createFixture();
  const aborted = runWithTransaction(fixture.context.adapter, async () => {
    await fixture.context.internalAdapter.updateUser(fixture.userId, {
      name: "Rolled back",
    });
    throw new APIError("FORBIDDEN", { message: "Abort transaction" });
  });
  expect(await rejectionOf(aborted)).toBeInstanceOf(APIError);
  expect(await fixture.name()).toBe("Before");
  fixture.refuse();
  expect(
    await rejectionOf(
      fixture.context.internalAdapter.updateUser(fixture.userId, {
        name: "Refused",
      }),
    ),
  ).toBeInstanceOf(APIError);
  expect(await fixture.name()).toBe("Before");
  expect(fixture.emitted).toEqual([]);
});

test.each(["read-failure", "publish-failure"] as const)(
  "a committed profile update remains successful when its notification has %s",
  async (failure) => {
    const fixture = await createFixture(failure);
    const updated = await runWithTransaction(
      fixture.context.adapter,
      async () =>
        await fixture.context.internalAdapter.updateUser(fixture.userId, {
          name: "Committed",
        }),
    );
    expect(updated.name).toBe("Committed");
    expect(await fixture.name()).toBe("Committed");
    expect(fixture.observed).toHaveLength(1);
    expect(fixture.observed.at(0)).toMatchObject({ cause: fixture.failure });
    expect(fixture.emitted).toEqual([]);
  },
);
