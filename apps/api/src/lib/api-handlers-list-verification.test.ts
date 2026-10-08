// The STELLA_RUN_POSTGRES_TESTS runner also executes this verification suite.
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";

import { legalListVerificationRuns } from "@/api/db/schema";
import { env } from "@/api/env";
import factDetails from "@/api/handlers/lists/items/fact-details/update";
import sourceReview from "@/api/handlers/lists/items/sources/verification/update";
import bulkReview from "@/api/handlers/lists/verifications/claim-reviews/bulk/create";
import review from "@/api/handlers/lists/verifications/claim-reviews/create";
import create from "@/api/handlers/lists/verifications/create";
import get from "@/api/handlers/lists/verifications/get";
import latest from "@/api/handlers/lists/verifications/latest/list";
import list from "@/api/handlers/lists/verifications/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch/lists.verifications.create";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

const context = (tx: unknown) => ({
  ...createScopedDbMock(tx, {
    featureAccess: {
      identity: { email: "member@example.test", emailVerified: true },
    },
  }),
  user: { id: toSafeId<"user">("user_a"), email: "member@example.test" },
  session: { activeOrganizationId: toSafeId<"organization">("org_a") },
  workspaceId: toSafeId<"workspace">("workspace_a"),
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  request: new Request("https://example.test/lists"),
  set: { headers: {} },
});

const endpoints = {
  create,
  list,
  get,
  latest,
  review,
  bulkReview,
  factDetails,
  sourceReview,
};

describe("verification handler access admission", () => {
  test("every dedicated handler denies empty grants before resource operations", async () => {
    const previous = env.API_FEATURE_ACCESS_GRANTS;
    const previousDeployment = env.FEATURE_LEGAL_LISTS;
    env.FEATURE_LEGAL_LISTS = true;
    env.API_FEATURE_ACCESS_GRANTS = {};
    try {
      for (const endpoint of Object.values(endpoints)) {
        expect(endpoint.config.featureAccess).toEqual({
          featureId: "list-verification",
          type: "required",
        });
        let operations = 0;
        const resourceOperation = () => {
          operations += 1;
          throw new Error("Resource operation must not run");
        };
        const tx = {
          select: resourceOperation,
          insert: resourceOperation,
          update: resourceOperation,
          delete: resourceOperation,
          query: new Proxy({}, { get: resourceOperation }),
        };
        const result = await endpoint.handler(
          asTestRaw({
            ...context(tx),
            params: { runId: createSafeId<"legalListVerificationRun">() },
            body: {},
          }),
        );
        expect(result).toMatchObject({
          code: 404,
          response: { message: "Not found" },
        });
        expect(operations).toBe(0);
      }
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous;
      env.FEATURE_LEGAL_LISTS = previousDeployment;
    }
  });

  test("point admission conceals populated and missing runs before selecting resources", async () => {
    const previous = env.API_FEATURE_ACCESS_GRANTS;
    const previousDeployment = env.FEATURE_LEGAL_LISTS;
    env.FEATURE_LEGAL_LISTS = true;
    env.API_FEATURE_ACCESS_GRANTS = {};
    const workspaceId = toSafeId<"workspace">("workspace_a");
    const storedRun = {
      id: createSafeId<"legalListVerificationRun">(),
      organizationId: toSafeId<"organization">("org_a"),
      workspaceId,
      entityId: createSafeId<"entity">(),
      fileFieldId: createSafeId<"field">(),
      entityVersionId: createSafeId<"entityVersion">(),
      contentSha256: "a".repeat(64),
      evidence: { listId: createSafeId<"legalList">(), facts: [] },
      status: "completed",
      errorCode: null,
      requestedBy: "user_a",
      pipelineVersion: 1,
      modelRef: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      startedAt: null,
      finishedAt: null,
    } satisfies typeof legalListVerificationRuns.$inferSelect;
    try {
      for (const exists of [true, false]) {
        const runId = exists
          ? storedRun.id
          : createSafeId<"legalListVerificationRun">();
        let selections = 0;
        const tx = {
          select: () => ({
            from: (table: unknown) => {
              selections += 1;
              return createSelectQueryMock(
                table === legalListVerificationRuns && exists
                  ? [storedRun]
                  : [],
              ).from();
            },
          }),
        };
        const fixture = context(tx);
        const control = await fixture.scopedDb(
          async (transaction) =>
            await readVerificationRun({ tx: transaction, workspaceId, runId }),
        );
        if (exists) {
          expect(control).toMatchObject({
            id: storedRun.id,
            status: "completed",
          });
        } else {
          expect(control).toBeNull();
        }
        expect(selections).toBeGreaterThan(0);
        selections = 0;
        expect(
          await get.handler(asTestRaw({ ...fixture, params: { runId } })),
        ).toMatchObject({
          code: 404,
          response: { message: "Not found" },
        });
        expect(selections).toBe(0);
      }
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous;
      env.FEATURE_LEGAL_LISTS = previousDeployment;
    }
  });

  test("a current verified member receives a proof for direct handler execution", async () => {
    const previous = env.API_FEATURE_ACCESS_GRANTS;
    const previousDeployment = env.FEATURE_LEGAL_LISTS;
    env.FEATURE_LEGAL_LISTS = true;
    env.API_FEATURE_ACCESS_GRANTS = {
      "list-verification": [
        {
          type: "member",
          organizationId: "org_a",
          email: "member@example.test",
        },
      ],
    };
    try {
      const config = {
        featureAccess: { featureId: "list-verification", type: "required" },
        permissions: { workspace: ["read"] },
        access: "read",
        accountAccess: "sandbox",
        mcp: { type: "internal", reason: "ui_navigation_state" },
      } satisfies HandlerConfig;
      let executions = 0;
      const endpoint = createSafeRootHandler(
        config,
        async function* ({ featureAccessProof }) {
          executions += 1;
          return Result.ok({ proof: featureAccessProof });
        },
      );
      const result = await endpoint.handler(asTestRaw(context({})));
      expect(result).toMatchObject({
        proof: {
          featureId: "list-verification",
          organizationId: "org_a",
          userId: "user_a",
        },
      });
      expect(executions).toBe(1);
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous;
      env.FEATURE_LEGAL_LISTS = previousDeployment;
    }
  });
});

test.each(["active", "daily"] as const)(
  "%s cap refusal reaches REST and capability transports",
  async (reason) => {
    const previous = {
      grants: env.API_FEATURE_ACCESS_GRANTS,
      deployment: env.FEATURE_LEGAL_LISTS,
      enforcement: env.USAGE_ENFORCEMENT_ENABLED,
      provider: env.AI_PROVIDER,
      providerKey: env.OPENROUTER_API_KEY,
      personalKey: env.REQUIRE_PERSONAL_AI_KEY,
    };
    env.FEATURE_LEGAL_LISTS = true;
    env.USAGE_ENFORCEMENT_ENABLED = false;
    // The verification model role must be available, so the cap check is
    // what refuses; configure the instance provider here instead of relying
    // on whatever another suite in the same process left behind.
    env.AI_PROVIDER = "openrouter";
    env.OPENROUTER_API_KEY = "test-openrouter-instance-key";
    env.REQUIRE_PERSONAL_AI_KEY = false;
    env.API_FEATURE_ACCESS_GRANTS = {
      "list-verification": [
        {
          type: "member",
          organizationId: "org_a",
          email: "member@example.test",
        },
      ],
    };
    try {
      let insertAttempts = 0;
      const body = {
        listId: toSafeId<"legalList">("01900000-0000-7000-8000-000000000001"),
        entityId: toSafeId<"entity">("01900000-0000-7000-8000-000000000002"),
        fileFieldId: toSafeId<"field">("01900000-0000-7000-8000-000000000003"),
      };
      const tx = {
        query: {
          entities: {
            findFirst: async () => ({
              currentVersion: {
                id: toSafeId<"entityVersion">(
                  "01900000-0000-7000-8000-000000000004",
                ),
                fields: [
                  {
                    id: body.fileFieldId,
                    content: {
                      type: "file",
                      mimeType: DOCX_MIME_TYPE,
                      pdfFileId: null,
                      encrypted: false,
                      sizeBytes: 100,
                      sha256Hex: "a".repeat(64),
                    },
                  },
                ],
              },
            }),
          },
          legalLists: { findFirst: async () => ({ id: body.listId }) },
        },
        select: (selection: Record<string, unknown>) => {
          const query = {
            innerJoin: () => query,
            leftJoin: () => query,
            where: () => query,
            orderBy: () => query,
            as: () => ({}),
            limit: async () =>
              "email" in selection
                ? [{ email: "member@example.test", emailVerified: true }]
                : [],
          };
          return { from: () => query };
        },
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                insertAttempts += 1;
                throw Object.assign(new TypeError("Postgres cap fixture"), {
                  code: "23514",
                  constraint: `legal_list_verification_${reason}_cap`,
                });
              },
            }),
          }),
        }),
      };
      const capability =
        await CAPABILITY_DISPATCH["lists.verifications.create"].load();
      for (const endpoint of [create, capability.default]) {
        const result = await endpoint.handler(
          asTestRaw({ ...context(tx), body }),
        );
        expect(result).toMatchObject({
          code: 429,
          response: { retryable: true },
        });
        const mapped = mapHandlerResult({
          id: "lists.verifications.create",
          result,
          access: "write",
        });
        expect(mapped).toMatchObject({
          status: "error",
          error: {
            type: "structured",
            code: VERIFICATION_RUN_CAP_CODES[reason],
            retryable: true,
            hint:
              reason === "active"
                ? "Wait for an active verification to finish, then retry lists.verifications.create."
                : "Retry lists.verifications.create after midnight in Europe/Prague.",
          },
        });
      }
      expect(insertAttempts).toBe(2);
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous.grants;
      env.FEATURE_LEGAL_LISTS = previous.deployment;
      env.USAGE_ENFORCEMENT_ENABLED = previous.enforcement;
      env.AI_PROVIDER = previous.provider;
      env.OPENROUTER_API_KEY = previous.providerKey;
      env.REQUIRE_PERSONAL_AI_KEY = previous.personalKey;
    }
  },
);
