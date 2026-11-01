import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";
import { RUNTIME_MODE } from "@stll/runtime-mode";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { flowsRoute } from "@/api/handlers/flows/routes";
import { flowRunsRoute } from "@/api/handlers/flows/run-route";
import { signalsRoute } from "@/api/handlers/signals/routes";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { ValidateAuthValue } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { createSafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { isRecord } from "@/api/lib/type-guards";
import {
  featureOmittedCapabilityIds,
  parseCatalog,
} from "@/api/mcp/capability-tools";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const FEATURES = [
  {
    id: "signals",
    flag: "FEATURE_SIGNALS",
    routes: { signalsRoute },
    handlerCount: 8,
    capabilityCount: 7,
  },
  {
    id: "flows",
    flag: "FEATURE_FLOWS",
    routes: { flowsRoute, flowRunsRoute },
    handlerCount: 10,
    capabilityCount: 10,
  },
] as const;
const ORGANIZATION_ID = mintAuthProviderId<"organization">();
const USER_ID = mintAuthProviderId<"user">();
const PATH_ID = createSafeId<"workspace">();

const contextFor = (featureId: "signals" | "flows", enrolled: boolean) => {
  const { safeDb, scopedDb } = createScopedDbMock({});
  const accessibleWorkspaces = [{ id: PATH_ID, status: "active" as const }];
  const accessibleWorkspaceIds = accessibleWorkspaces.map(({ id }) => id);
  return authorizedMcpContextForTest({
    safeDb,
    scopedDb,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    accessibleWorkspaceIds,
    accessibleWorkspaceIdSet: new Set(accessibleWorkspaceIds),
    accessibleWorkspaceStatusById: new Map(
      accessibleWorkspaces.map(({ id, status }) => [id, status]),
    ),
    accessibleWorkspaces,
    userEmail: "member@example.test",
    recordAuditEvent: async () =>
      panic("Feature-access fixture must not record an audit event"),
    grantedScopes: MCP_ALL_RESOURCE_SCOPES,
    memberRole: "owner",
    featureAccessSnapshot: createFeatureAccessSnapshot({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      decisions: new Map([
        [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId,
            userId: USER_ID,
            organizationId: ORGANIZATION_ID,
            membership: true,
            user: { email: "member@example.test", emailVerified: true },
            grants: {},
            enrolments: enrolled
              ? [
                  {
                    userId: USER_ID,
                    organizationId: ORGANIZATION_ID,
                    featureId,
                  },
                ]
              : [],
            // An enabled snapshot must not override the deployment off-switch.
            deploymentEnabled: true,
          }),
        ],
      ]),
    }),
  });
};

const testState = createTestState({ file: import.meta.path, config: env });

const withDeployment = async <T>(
  flag: "FEATURE_SIGNALS" | "FEATURE_FLOWS",
  enabled: boolean,
  run: () => Promise<T>,
) => {
  const previous = env[flag];
  testState.setConfig(flag, enabled);
  const restoreRuntimeMode = setRuntimeModeForTesting({
    mode: RUNTIME_MODE.strict,
  });
  try {
    return await run();
  } finally {
    testState.setConfig(flag, previous);
    restoreRuntimeMode();
  }
};

const errorCodeOf = (result: CallToolResult) => {
  const item = result.content.at(0);
  const parsed = v.safeParse(
    v.object({ error: v.object({ code: v.string() }) }),
    item?.type === "text" ? JSON.parse(item.text) : null,
  );
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.output.error.code : undefined;
};

for (const feature of FEATURES) {
  describe(`${feature.id} primary admission census`, () => {
    test("every owned handler and route belongs to the exercised census", async () => {
      const routeNames: string[] = [];
      const capabilityIds: string[] = [];
      let handlerCount = 0;
      for (const directory of FEATURE_REGISTRY[feature.id].ownership
        .handlerDirectories) {
        const absolute = `${import.meta.dir}/../../../../${directory}`;
        for (const filename of new Glob("**/*.ts").scanSync(absolute)) {
          if (filename.endsWith(".test.ts")) {
            continue;
          }
          const source = await Bun.file(`${absolute}/${filename}`).text();
          if (/export const \w+ = routes\(/u.test(source)) {
            expect(source).toContain(
              `deploymentFeatureGate("${feature.flag}")`,
            );
            expect(source).toContain(`featureAccessGate("${feature.id}")`);
            const name = /export const (\w+) = routes\(/u.exec(source)?.at(1);
            expect(name).toBeDefined();
            if (name !== undefined) {
              routeNames.push(name);
            }
          }
          if (!/createSafe(?:Root)?Handler\(/u.test(source)) {
            continue;
          }
          const module = await import(`${absolute}/${filename}`);
          expect(
            isRecord(module.default) && isRecord(module.default.config),
          ).toBe(true);
          if (!isRecord(module.default) || !isRecord(module.default.config)) {
            continue;
          }
          expect(module.default.config.featureAccess).toEqual({
            featureId: feature.id,
            type: "required",
          });
          handlerCount += 1;
          if (
            isRecord(module.default.config.mcp) &&
            module.default.config.mcp.type === "capability"
          ) {
            capabilityIds.push(
              `${feature.id}.${filename.replace(/\.ts$/u, "").replaceAll("/", ".")}`,
            );
          }
        }
      }
      expect(routeNames.toSorted()).toEqual(
        Object.keys(feature.routes).toSorted(),
      );
      expect(handlerCount).toBe(feature.handlerCount);
      expect(Object.values(feature.routes).flat().length).toBe(handlerCount);
      expect(capabilityIds.length).toBe(feature.capabilityCount);
      await withDeployment(feature.flag, true, async () => {
        const omitted = await featureOmittedCapabilityIds(
          (flag) => flag !== feature.flag,
          contextFor(feature.id, true),
        );
        expect(omitted.toSorted()).toEqual(capabilityIds.toSorted());
      });
    });

    test("all production routes answer not-found before input validation when deployment is off or the caller has no grant", async () => {
      for (const enabled of [false, true]) {
        await withDeployment(feature.flag, enabled, async () => {
          for (const route of Object.values(feature.routes)) {
            await using server = serveForTest(
              createHttpApp({ routes: route, middleware: [errorBoundary] }),
            );
            for (const { method, path } of route) {
              const response = await server.fetch(
                new Request(
                  `http://localhost${String(path).replaceAll(/:[A-Za-z]+/gu, () => "malformed-id")}`,
                  { method },
                ),
              );
              expect({ method, path, status: response.status }).toEqual({
                method,
                path,
                status: 404,
              });
            }
          }
        });
      }
    });

    test("deployment and caller grant must both admit a request, even when a stale snapshot grants access", async () => {
      for (const enabled of [false, true]) {
        for (const enrolled of [false, true]) {
          await withDeployment(feature.flag, enabled, async () => {
            let executions = 0;
            const context = contextFor(feature.id, enrolled);
            const route = routes(
              {
                "/": {
                  POST: defineEndpoint.public(
                    { body: v.object({ required: v.string() }) },
                    () => {
                      executions += 1;
                      return "served";
                    },
                  ),
                },
              },
              {
                middleware: [
                  deploymentFeatureGate(feature.flag, {
                    isEnabled: () => isDeploymentFeatureEnabled(feature.flag),
                  }),
                  featureAccessGate(feature.id, {
                    resolveAuth: async () => ({
                      ok: true,
                      value: createTestHandlerContext<ValidateAuthValue>({
                        audit: NO_AUDIT,
                        safeDb: NO_DB,
                        scopedDb: NO_DB,
                        user: { id: context.userId },
                        session: {
                          activeOrganizationId: context.organizationId,
                        },
                        featureAccessSnapshot: context.featureAccessSnapshot,
                      }),
                    }),
                  }),
                ],
              },
            );
            await using server = serveForTest(
              createHttpApp({ routes: route, middleware: [errorBoundary] }),
            );
            for (const body of ["{}", '{"required":"valid"}']) {
              const response = await server.fetch(
                new Request("http://localhost/", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body,
                }),
              );
              let expectedStatus = 404;
              if (enabled && enrolled) {
                expectedStatus = body === "{}" ? 422 : 200;
              }
              expect(response.status).toBe(expectedStatus);
            }
            expect(executions).toBe(enabled && enrolled ? 1 : 0);
          });
        }
      }
    });

    test("MCP discovery and the CLI catalog require deployment and the caller's own grant", async () => {
      const expectedCapabilities = await withDeployment(
        feature.flag,
        true,
        async () =>
          await featureOmittedCapabilityIds(
            (flag) => flag !== feature.flag,
            contextFor(feature.id, true),
          ),
      );
      expect(expectedCapabilities.length).toBe(feature.capabilityCount);
      const catalogEntries = parseCatalog(readCapabilityCatalog());
      for (const enabled of [false, true]) {
        for (const enrolled of [false, true]) {
          await withDeployment(feature.flag, enabled, async () => {
            const context = contextFor(feature.id, enrolled);
            const omittedCapabilities = await featureOmittedCapabilityIds(
              undefined,
              context,
            );
            const listed = await handleMcpToolCall({
              mode: "advanced",
              toolName: "list_capabilities",
              args: { domain: feature.id, limit: 100 },
              context,
            });
            const catalog = v.parse(
              v.object({
                items: v.array(v.object({ id: v.string() })),
              }),
              listed.structuredContent,
            );
            expect(catalog.items.map(({ id }) => id).toSorted()).toEqual(
              enabled && enrolled ? expectedCapabilities.toSorted() : [],
            );
            for (const capability of expectedCapabilities) {
              expect(omittedCapabilities.includes(capability)).toBe(
                !enabled && enrolled,
              );
              const result = await handleMcpToolCall({
                mode: "advanced",
                toolName:
                  MCP_CAPABILITY_EXECUTORS[
                    catalogEntries.find(({ id }) => id === capability)
                      ?.access ??
                      panic(`Missing capability catalog entry: ${capability}`)
                  ],
                args: { capability, input: {} },
                context: { ...context, grantedScopes: [] },
              });
              if (!enrolled) {
                expect(errorCodeOf(result)).toBe("not_found");
              } else if (!enabled) {
                expect(errorCodeOf(result)).toBe("feature_disabled");
              } else {
                expect(errorCodeOf(result)).toBe("missing_scope");
              }
            }
          });
        }
      }
    });
  });
}
