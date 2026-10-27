import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import type { ResourceType } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  billingDraftUserSettings,
  billingGuidelineFiles,
  contacts,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { requireSkillManager } from "@/api/handlers/skills/managed-skill";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { deploymentFeatureGateFlag } from "@/api/lib/deployment-feature-route";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { toRouteJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { announceResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { executeRowsSafeDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { responseSchemaByteBound } from "@/api/tests/helpers/response-schema-byte-bound";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import {
  listBillingKnowledgeFiles,
  readBillingKnowledgeFile,
} from "./billing-drafts";
import readBillingDraftConfiguration from "./billing-drafts/get";
import updateBillingDraftConfiguration from "./billing-drafts/update";
import { organizationSettingsRoute } from "./routes";

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
        featureAccessSnapshot: buildFeatureAccessSnapshot({
          userId,
          organizationId,
          identity: { email: `${userId}@example.test`, emailVerified: true },
          enrolments: [{ userId, organizationId, featureId: "time-billing" }],
        }),
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
        listBillingKnowledgeFiles,
        readBillingKnowledgeFile,
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

test("billing read response contracts reject oversized guideline content without truncation", () => {
  const content = "x".repeat(LIMITS.agentSkillResourceMaxChars);
  const schema = readBillingKnowledgeFile.config.response[200];
  const accepted = v.parse(schema, { content });
  expect(accepted.content).toBe(content);
  expect(v.safeParse(schema, { content: `${content}x` }).success).toBe(false);
  const file = {
    fileId: createSafeId<"agentSkillResource">(),
    fileName: "references/billing.md",
    content,
    clientId: null,
  };
  const configuration = {
    mode: "enabled",
    updatedAt: new Date(0).toISOString(),
    files: [file],
    timeBillingFormat: "categories",
  };
  const configurationSchema =
    readBillingDraftConfiguration.config.response[200];
  expect(v.parse(configurationSchema, configuration).files.at(0)?.content).toBe(
    content,
  );
  expect(
    v.safeParse(configurationSchema, {
      ...configuration,
      files: [{ ...file, content: `${content}x` }],
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(configurationSchema, {
      ...configuration,
      files: Array.from({ length: 12 }, () => file),
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(listBillingKnowledgeFiles.config.response[200], {
      items: [],
      nextCursor: null,
      limit: 21,
    }).success,
  ).toBe(false);
});

test("billing configuration announces organization and contact sets only after committed success", () => {
  const announced: ResourceType[] = [];
  const organizationId = mintAuthProviderId<"organization">();
  const notify = (result: unknown) =>
    announceResourceSetUpdates({
      realtime: updateBillingDraftConfiguration.config.realtime,
      result,
      organizationId,
      workspaceId: undefined,
      broadcasts: {
        organization: (_organizationId, resourceType) => {
          announced.push(resourceType);
        },
        workspace: () => panic("Root settings must not announce a matter"),
      },
    });
  notify(new HttpStatusResponse(409, { message: "stale" }));
  expect(announced).toEqual([]);
  notify({ updated: true });
  expect(announced).toEqual([
    RESOURCE_TYPE.ORGANIZATION,
    RESOURCE_TYPE.CONTACT,
  ]);
});

test("time billing deployment gate scopes billing administration without hiding general settings", () => {
  const billing = organizationSettingsRoute.filter(({ path }) =>
    path.startsWith("/organization-settings/billing-drafts"),
  );
  expect(billing).toHaveLength(4);
  for (const route of billing) {
    expect(
      route.middleware.some(
        (stage) => deploymentFeatureGateFlag(stage) === "FEATURE_TIME_BILLING",
      ),
    ).toBe(true);
  }
  const general = organizationSettingsRoute.filter(
    ({ path }) => path === "/organization-settings",
  );
  expect(general).toHaveLength(2);
  for (const route of general) {
    expect(
      route.middleware.some(
        (stage) => deploymentFeatureGateFlag(stage) === "FEATURE_TIME_BILLING",
      ),
    ).toBe(false);
  }
});

test("billing administration wire responses have finite text bounds and valid instants", () => {
  for (const endpoint of [
    readBillingDraftConfiguration,
    updateBillingDraftConfiguration,
    listBillingKnowledgeFiles,
    readBillingKnowledgeFile,
  ]) {
    expect(
      Number.isFinite(
        responseSchemaByteBound(
          toRouteJsonSchema(endpoint.config.response[200]),
        ),
      ),
    ).toBe(true);
  }
  expect(
    v.safeParse(updateBillingDraftConfiguration.config.response[200], {
      updated: true,
      updatedAt: "0000-01-01T00:00:00Z",
    }).success,
  ).toBe(false);
});
