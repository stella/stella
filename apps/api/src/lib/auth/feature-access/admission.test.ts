import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  createSafeRootHandler,
  type HandlerConfig,
} from "@/api/lib/api-handlers";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const featureId = "fixture-access";
const registry = { [featureId]: { enrolment: "invitation" } } as const;
const snapshot = (userId: string, organizationId: string, invited: boolean) =>
  createFeatureAccessSnapshot({
    organizationId,
    userId,
    decisions: new Map([
      [
        featureId,
        decideFeatureAccess({
          registry,
          featureId,
          userId,
          organizationId,
          user: {
            email: invited ? "invited@example.test" : "colleague@example.test",
            emailVerified: true,
          },
          membership: true,
          grants: {
            [featureId]: [
              {
                type: "member",
                organizationId: "org_1",
                email: "invited@example.test",
              },
            ],
          },
        }),
      ],
    ]),
  });

describe("feature access safe-handler admission", () => {
  test("required features are hidden without a supplied snapshot before handler reads or execution", async () => {
    let executions = 0;
    let identityQueries = 0;
    const endpoint = createSafeRootHandler(
      asTestRaw<HandlerConfig>({
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: { type: "required", featureId },
      }),
      async function* () {
        executions += 1;
        return Result.ok({ ok: true });
      },
    );
    const database = createScopedDbMock({
      select: () => {
        identityQueries += 1;
      },
    });
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
      }),
    );
    expect(result).toMatchObject({
      code: 404,
      response: { message: "Not found" },
    });
    expect(executions).toBe(0);
    expect(identityQueries).toBe(0);
    expect(database.getCallCount()).toBe(1);
  });

  test("required admission recomputes snapshots supplied for another user or organization", async () => {
    const supplied = snapshot("user_1", "org_1", true);
    for (const principal of [
      { userId: "user_2", organizationId: "org_1" },
      { userId: "user_1", organizationId: "org_2" },
    ]) {
      let executions = 0;
      const endpoint = createSafeRootHandler(
        asTestRaw<HandlerConfig>({
          permissions: { workspace: ["read"] },
          mcp: { type: "internal", reason: "health_infra" },
          featureAccess: { type: "required", featureId },
        }),
        async function* () {
          executions += 1;
          return Result.ok({ ok: true });
        },
      );
      const database = createScopedDbMock({});
      const result = await endpoint.handler(
        createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
          safeDb: database.safeDb,
          scopedDb: database.scopedDb,
          featureAccessSnapshot: supplied,
          user: { id: toSafeId<"user">(principal.userId) },
          session: {
            activeOrganizationId: toSafeId<"organization">(
              principal.organizationId,
            ),
          },
        }),
      );
      expect(result).toMatchObject({
        code: 404,
        response: { message: "Not found" },
      });
      expect(executions).toBe(0);
      expect(database.getCallCount()).toBe(1);
    }
  });

  test("conditional operations receive a proof only for a decision matching their caller and feature", async () => {
    const supplied = snapshot("user_1", "org_1", true);
    const otherFeature = "fixture-other";
    const decisions = new Map(supplied.decisions);
    const mismatchedSnapshot = { ...supplied, decisions };
    const enabled = supplied.decisions.get(featureId);
    expect(enabled?.status).toBe("enabled");
    if (enabled === undefined || enabled.status !== "enabled") {
      throw new Error("Expected an enabled fixture decision");
    }
    decisions.set(otherFeature, enabled);
    let executions = 0;
    const endpoint = createSafeRootHandler(
      asTestRaw<HandlerConfig>({
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: {
          type: "conditional",
          featureId: otherFeature,
          usesFeature: async () => false,
          projectInputSchema: (schemas: unknown) => schemas,
        },
      }),
      async function* (context) {
        executions += 1;
        expect(context.featureAccessProof).toBeUndefined();
        return Result.ok({ ok: true });
      },
    );
    const database = createScopedDbMock({});
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
        featureAccessSnapshot: mismatchedSnapshot,
        featureAccessProof: enabled.proof,
        user: { id: toSafeId<"user">("user_1") },
        session: { activeOrganizationId: toSafeId<"organization">("org_1") },
      }),
    );
    expect(result).toEqual({ ok: true });
    expect(executions).toBe(1);
    expect(database.getCallCount()).toBe(0);
  });

  test("conditional metadata failures use the shared handler error response", async () => {
    let executions = 0;
    const endpoint = createSafeRootHandler(
      asTestRaw<HandlerConfig>({
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: {
          type: "conditional",
          featureId,
          usesFeature: async () => {
            throw new DatabaseError({ message: "Fixture metadata failure" });
          },
          projectInputSchema: (schemas: unknown) => schemas,
        },
      }),
      async function* () {
        executions += 1;
        return Result.ok({ ok: true });
      },
    );
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        featureAccessSnapshot: snapshot("user_1", "org_1", false),
        user: { id: toSafeId<"user">("user_1") },
        session: { activeOrganizationId: toSafeId<"organization">("org_1") },
      }),
    );
    expect(result).toMatchObject({
      code: 500,
      response: { message: "Internal server error" },
    });
    expect(executions).toBe(0);
  });

  test.each([
    ["user_1", "org_1", false],
    ["user_2", "org_1", false],
    ["user_1", "org_2", true],
    ["user_1", "org_1", true],
  ])("principal %s %s grant %s", async (userId, organizationId, invited) => {
    let executions = 0;
    let reads = 0;
    const endpoint = createSafeRootHandler(
      asTestRaw<HandlerConfig>({
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: { type: "required", featureId },
      }),
      async function* () {
        executions += 1;
        return Result.ok({ ok: true });
      },
    );
    const app = new Elysia().get("/fixture", async ({ set }) =>
      endpoint.handler(
        asTestRaw({
          set,
          request: new Request("https://example.test/fixture"),
          route: "/fixture",
          user: { id: toSafeId<"user">(userId) },
          session: {
            activeOrganizationId: toSafeId<"organization">(organizationId),
          },
          memberRole: { role: "owner" },
          featureAccessSnapshot: snapshot(userId, organizationId, invited),
          safeDb: async () => {
            reads += 1;
            return Result.ok(undefined);
          },
          orgAIConfig: null,
          orgAIConfigStatus: "ok",
          managedAIResidency: "eu",
        }),
      ),
    );
    const response = await app.handle(new Request("http://localhost/fixture"));
    const enabled =
      userId === "user_1" && organizationId === "org_1" && invited;
    expect(response.status).toBe(enabled ? 200 : 404);
    expect(executions).toBe(enabled ? 1 : 0);
    expect(reads).toBe(0);
    if (!enabled) {
      expect(await response.json()).toMatchObject({ message: "Not found" });
    }
  });
});
