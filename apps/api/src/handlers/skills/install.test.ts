import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { authorizeSkillInstallScope, preflightSkillInstall } from "./install";

const organizationId = toSafeId<"organization">(
  "019e7000-0000-7000-8000-000000000002",
);
const userId = toSafeId<"user">("019e7000-0000-7000-8000-000000000001");
const slug = "contract-review";

describe("agent skill install authorization", () => {
  test("rejects team installs for non-admin organization members", () => {
    const result = authorizeSkillInstallScope({
      memberRole: { role: "member" },
      scope: "team",
    });

    expect(Result.isError(result)).toBe(true);
  });

  test("allows private installs for organization members", () => {
    const result = authorizeSkillInstallScope({
      memberRole: { role: "member" },
      scope: "private",
    });

    expect(Result.isOk(result)).toBe(true);
  });
});

describe("agent skill install preflight", () => {
  test("matches team duplicates by organization, scope, and slug", async () => {
    const database = createPreflightDatabase();

    const result = await preflightSkillInstall({
      memberRole: { role: "owner" },
      safeDb: database.safeDb,
      scope: "team",
      session: { activeOrganizationId: organizationId },
      slug,
      user: { id: userId },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(compiledParams(database.duplicateConditions.at(0))).toEqual([
      organizationId,
      "team",
      slug,
    ]);
  });

  test("matches private duplicates by organization, user, scope, and slug", async () => {
    const database = createPreflightDatabase();

    const result = await preflightSkillInstall({
      memberRole: { role: "member" },
      safeDb: database.safeDb,
      scope: "private",
      session: { activeOrganizationId: organizationId },
      slug,
      user: { id: userId },
    });

    expect(Result.isOk(result)).toBe(true);
    expect(compiledParams(database.duplicateConditions.at(0))).toEqual([
      organizationId,
      userId,
      "private",
      slug,
    ]);
  });

  test("rejects a duplicate before installation and authorization before database reads", async () => {
    const duplicateDatabase = createPreflightDatabase([
      { id: toSafeId<"agentSkill">("019e7000-0000-7000-8000-000000000003") },
    ]);
    const duplicate = await preflightSkillInstall({
      memberRole: { role: "owner" },
      safeDb: duplicateDatabase.safeDb,
      scope: "team",
      session: { activeOrganizationId: organizationId },
      slug,
      user: { id: userId },
    });

    expect(Result.isError(duplicate)).toBe(true);
    if (Result.isOk(duplicate)) {
      throw new Error("expected duplicate preflight to fail");
    }
    expect(duplicate.error.status).toBe(409);

    const unauthorizedDatabase = createPreflightDatabase();
    const unauthorized = await preflightSkillInstall({
      memberRole: { role: "member" },
      safeDb: unauthorizedDatabase.safeDb,
      scope: "team",
      session: { activeOrganizationId: organizationId },
      slug,
      user: { id: userId },
    });

    expect(Result.isError(unauthorized)).toBe(true);
    expect(unauthorizedDatabase.getCallCount()).toBe(0);
  });
});

const createPreflightDatabase = (
  duplicates: readonly { id: SafeId<"agentSkill"> }[] = [],
) => {
  const duplicateConditions: SQL[] = [];
  const query = {
    from: () => query,
    limit: async () => duplicates,
    where: (condition: SQL) => {
      duplicateConditions.push(condition);
      return query;
    },
  };
  const { getCallCount, safeDb } = createScopedDbMock({
    $count: async () => 0,
    select: () => query,
  });
  return { duplicateConditions, getCallCount, safeDb };
};

const compiledParams = (condition: SQL | undefined): unknown[] => {
  if (!condition) {
    throw new Error("expected the duplicate predicate to be captured");
  }
  return new PgDialect().sqlToQuery(condition).params;
};
