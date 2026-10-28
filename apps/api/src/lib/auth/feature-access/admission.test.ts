import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import { decodeRequestInput } from "@/api/http/input";
import { routes } from "@/api/http/route";
import type { RouteRequest } from "@/api/http/route";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import type { FeatureId } from "@/api/lib/feature-access/registry";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const featureId = "fixture-access";
// The fixture features are not registered, so handler configs name them
// through the test-only cast.
const requiredFeatureId = asTestRaw<FeatureId>(featureId);
const registry = { [featureId]: { enrolment: "invitation" } } as const;
// Recomputing against the production registry resolves the caller's identity
// and enrolments; neither grants a fixture feature.
const unenrolledDatabase = () =>
  createScopedDbMock(
    {},
    {
      featureAccess: {
        identity: { email: "colleague@example.test", emailVerified: true },
      },
    },
  );
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

/** Serve one GET route behind the production error boundary. */
const serveGet = (
  path: string,
  answer: (request: RouteRequest) => Promise<unknown>,
) =>
  serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({
        [path]: { GET: { access: "public", config: {}, run: answer } },
      }),
    }),
  );

describe("feature access safe-handler admission", () => {
  test.each(["always", "when-used"] as const)(
    "conditional decision hydration follows %s before discovery",
    async (decision) => {
      let identityQueries = 0;
      const database = createScopedDbMock({
        select: () => {
          identityQueries += 1;
          return {
            from: () => ({
              innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
            }),
          };
        },
      });
      const endpoint = createSafeRootHandler(
        {
          contract: "patch",
          accountAccess: ACCOUNT_ACCESS.sandbox,
          permissions: { workspace: ["read"] },
          mcp: { type: "internal", reason: "health_infra" },
          featureAccess: {
            type: "conditional",
            decision,
            featureId: requiredFeatureId,
            usesFeature: () => false,
            projectInputSchema: (schemas) => schemas,
          },
        },
        async function* ({ featureAccessSnapshot }) {
          return Result.ok({
            snapshot:
              featureAccessSnapshot === undefined ? "absent" : "resolved",
          });
        },
      );
      const result = await endpoint.handler(
        createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
          audit: NO_AUDIT,
          safeDb: database.safeDb,
          scopedDb: database.scopedDb,
        }),
      );
      expect(result).toEqual({
        snapshot: decision === "always" ? "resolved" : "absent",
      });
      expect(identityQueries).toBe(decision === "always" ? 1 : 0);
    },
  );

  test("ordinary conditional requests need no feature identity read", async () => {
    const endpoint = createSafeRootHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: {
          type: "conditional",
          decision: "when-used",
          featureId: requiredFeatureId,
          usesFeature: async () => false,
          projectInputSchema: (schemas) => schemas,
        },
      } as const satisfies Parameters<typeof createSafeRootHandler>[0],
      async function* ({ featureAccessProof }) {
        expect(featureAccessProof).toBeUndefined();
        return Result.ok({ ok: true });
      },
    );
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  test("required features are hidden without a supplied snapshot before handler reads or execution", async () => {
    let executions = 0;
    const endpoint = createSafeRootHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: { type: "required", featureId: requiredFeatureId },
      } as const satisfies Parameters<typeof createSafeRootHandler>[0],
      async function* () {
        executions += 1;
        return Result.ok({ ok: true });
      },
    );
    const database = createScopedDbMock(
      {},
      { featureAccess: { identity: null } },
    );
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        audit: NO_AUDIT,
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
      }),
    );
    expect(result).toMatchObject({
      code: 404,
      response: { message: "Not found" },
    });
    expect(executions).toBe(0);
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
        {
          contract: "patch",
          accountAccess: ACCOUNT_ACCESS.sandbox,
          permissions: { workspace: ["read"] },
          mcp: { type: "internal", reason: "health_infra" },
          featureAccess: { type: "required", featureId: requiredFeatureId },
        } as const satisfies Parameters<typeof createSafeRootHandler>[0],
        async function* () {
          executions += 1;
          return Result.ok({ ok: true });
        },
      );
      const database = unenrolledDatabase();
      const result = await endpoint.handler(
        createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
          audit: NO_AUDIT,
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
    if (enabled?.status !== "enabled") {
      throw new Error("Expected an enabled fixture decision");
    }
    expect(enabled.status).toBe("enabled");
    decisions.set(otherFeature, enabled);
    let executions = 0;
    const endpoint = createSafeRootHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: {
          type: "conditional",
          decision: "when-used",
          featureId: asTestRaw<FeatureId>(otherFeature),
          usesFeature: async () => false,
          projectInputSchema: (schemas) => schemas,
        },
      } as const satisfies Parameters<typeof createSafeRootHandler>[0],
      async function* (context) {
        executions += 1;
        expect(context.featureAccessProof).toBeUndefined();
        return Result.ok({ ok: true });
      },
    );
    const database = createScopedDbMock({});
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        audit: NO_AUDIT,
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
    let observedUserId: unknown;
    const endpoint = createSafeRootHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: {
          type: "conditional",
          decision: "when-used",
          featureId: requiredFeatureId,
          usesFeature: async ({ userId }) => {
            observedUserId = userId;
            throw new DatabaseError({ message: "Fixture metadata failure" });
          },
          projectInputSchema: (schemas) => schemas,
        },
      } as const satisfies Parameters<typeof createSafeRootHandler>[0],
      async function* () {
        executions += 1;
        return Result.ok({ ok: true });
      },
    );
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
        featureAccessSnapshot: snapshot("user_1", "org_1", false),
        user: { id: toSafeId<"user">("user_1") },
        session: { activeOrganizationId: toSafeId<"organization">("org_1") },
      }),
    );
    expect(result).toMatchObject({
      code: 500,
      response: { message: "Internal server error" },
    });
    expect(observedUserId).toBe("user_1");
    expect(executions).toBe(0);
  });

  test.each([
    ["user_1", "org_1", false],
    ["user_2", "org_1", false],
    ["user_1", "org_2", true],
    ["user_1", "org_1", true],
  ])("principal %s %s grant %s", async (userId, organizationId, invited) => {
    let executions = 0;
    const database = createScopedDbMock({});
    const endpoint = createSafeRootHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: { type: "required", featureId: requiredFeatureId },
      } as const satisfies Parameters<typeof createSafeRootHandler>[0],
      async function* () {
        executions += 1;
        return Result.ok({ ok: true });
      },
    );
    await using server = serveGet(
      "/fixture",
      async ({ ctx }) =>
        await endpoint.handler(
          createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
            audit: NO_AUDIT,
            scopedDb: NO_DB,
            set: ctx.set,
            request: ctx.request,
            route: "/fixture",
            user: {
              id: toSafeId<"user">(userId),
              email: "invited@example.test",
            },
            session: {
              activeOrganizationId: toSafeId<"organization">(organizationId),
            },
            memberRole: sessionMemberRole("owner"),
            featureAccessSnapshot: snapshot(userId, organizationId, invited),
            safeDb: database.safeDb,
          }),
        ),
    );
    const response = await server.fetch("http://localhost/fixture");
    const enabled =
      userId === "user_1" && organizationId === "org_1" && invited;
    expect(response.status).toBe(enabled ? 200 : 404);
    expect(executions).toBe(enabled ? 1 : 0);
    expect(database.getCallCount()).toBe(0);
    if (!enabled) {
      expect(await response.json()).toMatchObject({ message: "Not found" });
    }
  });
});

const conditionalQuerySchema = v.object({
  mode: v.picklist(["ordinary", "feature"]),
});

test.each([
  ["default-deny", "user_1", false],
  ["granted", "user_1", true],
  ["colleague", "user_2", false],
] as const)(
  "REST conditional query admission for %s",
  async (_kind, userId, granted) => {
    let resourceOperations = 0;
    const checkedQueries: unknown[] = [];
    const database = createScopedDbMock({});
    const endpoint = createSafeRootHandler(
      {
        contract: "patch",
        query: conditionalQuerySchema,
        accountAccess: ACCOUNT_ACCESS.sandbox,
        permissions: { workspace: ["read"] },
        mcp: { type: "internal", reason: "health_infra" },
        featureAccess: {
          type: "conditional",
          decision: "when-used",
          featureId: requiredFeatureId,
          usesFeature: async ({ query }) => {
            checkedQueries.push(query);
            return isRecord(query) && query["mode"] === "feature";
          },
          projectInputSchema: (schemas) => schemas,
        },
      } as const satisfies Parameters<typeof createSafeRootHandler>[0],
      async function* ({ safeDb, query }) {
        const output = yield* Result.await(
          safeDb(async () => {
            resourceOperations += 1;
            return { query };
          }),
        );
        return Result.ok(output);
      },
    );
    await using server = serveGet(
      "/query-fixture",
      async ({ ctx }) =>
        await endpoint.handler(
          createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
            audit: NO_AUDIT,
            query: await decodeRequestInput(conditionalQuerySchema, ctx.query),
            request: ctx.request,
            set: ctx.set,
            user: {
              id: toSafeId<"user">(userId),
              email: "invited@example.test",
            },
            session: {
              activeOrganizationId: toSafeId<"organization">("org_1"),
            },
            featureAccessSnapshot: snapshot(userId, "org_1", granted),
            safeDb: database.safeDb,
            scopedDb: database.scopedDb,
          }),
        ),
    );
    const selected = await server.fetch(
      "http://localhost/query-fixture?mode=feature",
    );
    expect(selected.status).toBe(granted ? 200 : 404);
    expect(resourceOperations).toBe(granted ? 1 : 0);
    expect(database.getCallCount()).toBe(granted ? 1 : 0);
    expect(checkedQueries).toEqual(granted ? [] : [{ mode: "feature" }]);
    if (!granted) {
      expect(await selected.json()).toEqual({ message: "Not found" });
    }
    const ordinary = await server.fetch(
      "http://localhost/query-fixture?mode=ordinary",
    );
    expect(ordinary.status).toBe(200);
    expect(await ordinary.json()).toEqual({ query: { mode: "ordinary" } });
    expect(resourceOperations).toBe(granted ? 2 : 1);
    const invalid = await server.fetch(
      "http://localhost/query-fixture?mode=invalid",
    );
    expect(invalid.status).toBe(422);
    expect(resourceOperations).toBe(granted ? 2 : 1);
  },
);
