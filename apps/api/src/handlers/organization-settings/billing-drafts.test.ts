import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  billingDraftUserSettings,
  billingGuidelineFiles,
  contacts,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { requireSkillManager } from "@/api/handlers/skills/managed-skill";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { executeRowsSafeDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import readBillingDraftConfiguration from "./billing-drafts/get";
import updateBillingDraftConfiguration from "./billing-drafts/update";

const dialect = new PgDialect();

// timeout: The real PGlite fixture restores the schema snapshot before handler execution.
test("billing configuration refuses missing and foreign clients while retaining firm defaults", async () => {
  const db = await getTestDb();
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const membershipId = Bun.randomUUIDv7();
  const ownClientId = createSafeId<"contact">();
  const foreignClientId = createSafeId<"contact">();
  const safeDb = executeRowsSafeDb(
    createSafeDb(db, [], organizationId, userId),
  );
  const read = async (clientId?: SafeId<"contact">) =>
    await readBillingDraftConfiguration.handler(
      asTestRaw<Parameters<typeof readBillingDraftConfiguration.handler>[0]>({
        safeDb,
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("owner"),
        query: clientId === undefined ? {} : { clientId },
        request: new Request(
          "https://example.test/v1/organization-settings/billing-drafts",
        ),
        route:
          "/v1/organization-settings/billing-drafts" satisfies ApiRoutePath,
      }),
    );
  try {
    await db.insert(organization).values(
      [organizationId, otherOrganizationId].map((id) => ({
        id,
        name: "Billing settings fixture",
        slug: id,
        createdAt: new Date(),
      })),
    );
    await db.insert(user).values({
      id: userId,
      name: "Billing administrator",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db.insert(member).values({
      id: membershipId,
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(contacts).values([
      {
        id: foreignClientId,
        organizationId: otherOrganizationId,
        type: "organization",
        displayName: "Foreign billing client",
        timeBillingFormat: "ledes",
      },
      {
        id: ownClientId,
        organizationId,
        type: "organization",
        displayName: "Own billing client",
        timeBillingFormat: "ledes",
      },
    ]);
    expect(await read()).toMatchObject({
      mode: "disabled",
      timeBillingFormat: "categories",
      files: [],
    });
    expect(await read(ownClientId)).toMatchObject({
      timeBillingFormat: "ledes",
    });
    for (const clientId of [createSafeId<"contact">(), foreignClientId]) {
      expect(await read(clientId)).toMatchObject({
        code: 404,
        response: { message: "Client not found" },
      });
    }
  } finally {
    await db
      .delete(contacts)
      .where(inArray(contacts.id, [ownClientId, foreignClientId]));
    await db
      .delete(organization)
      .where(inArray(organization.id, [organizationId, otherOrganizationId]));
    await db.delete(user).where(eq(user.id, userId));
    await releaseTestDb();
  }
}, 120_000);

describe("billing draft configuration authorization", () => {
  test("only administrators manage the gate, attachments, and knowledge content", () => {
    const userId = toSafeId<"user">("billing-draft-test-user");
    for (const role of [
      "owner",
      "admin",
      "member",
      "intern",
      "external",
    ] as const) {
      const allowed = role === "owner" || role === "admin";
      const memberRole = sessionMemberRole(role);
      for (const handler of [
        readBillingDraftConfiguration,
        updateBillingDraftConfiguration,
      ]) {
        expect(
          hasMemberPermission(memberRole, handler.config.permissions),
        ).toBe(allowed);
      }
      expect(
        requireSkillManager({
          skill: {
            scope: "team",
            userId,
            boundClientId: null,
            boundWorkspaceId: null,
          },
          userId,
          memberRole,
          action: "edit",
        }).isOk(),
      ).toBe(allowed);
    }
  });

  test("every attachment mutation checks the organization and current admin membership in SQL", () => {
    const policies = getTableConfig(billingGuidelineFiles).policies;
    for (const action of ["insert", "update", "delete"] as const) {
      const policy = policies.find((candidate) => candidate.for === action);
      expect(policy).toBeDefined();
      const expression =
        action === "insert" ? policy?.withCheck : policy?.using;
      expect(expression).toBeDefined();
      if (!expression) {
        panic("Mutation policy requires an expression");
      }
      const sql = dialect.sqlToQuery(expression).sql;
      expect(sql).toContain("app.organization_id");
      expect(sql).toContain("app.user_id");
      expect(sql).toContain("m.role IN ('owner', 'admin')");
    }
    for (const policy of getTableConfig(billingDraftUserSettings).policies) {
      const expression = policy.using ?? policy.withCheck;
      if (!expression) {
        panic("Personal settings policy requires an expression");
      }
      const sql = dialect.sqlToQuery(expression).sql;
      expect(sql).toContain("app.user_id");
      expect(sql).toContain("app.organization_id");
    }
  });

  test("refuses unknown configuration fields, unsupported modes, duplicate files, and excessive client attachments", () => {
    const resourceId = createSafeId<"agentSkillResource">();
    for (const body of [
      { mode: "other" },
      { mode: "enabled", content: "unowned markdown" },
      { resourceIds: [resourceId, resourceId] },
      {
        resourceIds: Array.from({ length: 11 }, () =>
          createSafeId<"agentSkillResource">(),
        ),
      },
      { timeBillingFormat: "other" },
    ]) {
      expect(v.is(updateBillingDraftConfiguration.config.body, body)).toBe(
        false,
      );
    }
    expect(
      v.is(updateBillingDraftConfiguration.config.body, {
        mode: "enabled",
        resourceIds: [resourceId],
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
    ).toBe(true);
    expect(
      v.is(updateBillingDraftConfiguration.config.body, {
        mode: "enabled",
        resourceIds: [resourceId],
      }),
    ).toBe(false);
    expect(updateBillingDraftConfiguration.config.contract).toBe("patch");
  });
});
