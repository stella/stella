import type { CallToolResult } from "@modelcontextprotocol/server";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import * as v from "valibot";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { flowsRoute } from "@/api/handlers/flows/routes";
import { flowRunsRoute } from "@/api/handlers/flows/run-route";
import { signalsRoute } from "@/api/handlers/signals/routes";
import type { ValidateAuthValue } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import { featureOmittedCapabilityIds } from "@/api/mcp/capability-tools";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
const ORGANIZATION_ID = "org_test";
const USER_ID = "user_test";
const PATH_ID = "00000000-0000-4000-8000-000000000001";

const contextFor = (featureId: "signals" | "flows", enrolled: boolean) =>
  asTestRaw<McpRequestContext>({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    accessibleWorkspaceIds: [PATH_ID],
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
          if (/export const \w+ = new Elysia/u.test(source)) {
            expect(source).toContain(
              `isDeploymentFeatureEnabled("${feature.flag}")`,
            );
            expect(source).toContain(
              `.use(featureAccessGate("${feature.id}"))`,
            );
            const name = /export const (\w+) = new Elysia/u.exec(source)?.at(1);
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
      expect(
        Object.values(feature.routes).flatMap((route) => route.routes).length,
      ).toBe(handlerCount);
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
            for (const { method, path } of route.routes) {
              const response = await route.handle(
                new Request(
                  `http://localhost${path.replaceAll(/:[A-Za-z]+/gu, () => "malformed-id")}`,
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
            const route = new Elysia()
              .use(
                deploymentFeatureGate(() =>
                  isDeploymentFeatureEnabled(feature.flag),
                ),
              )
              .use(
                featureAccessGate(feature.id, {
                  resolveAuth: async () => ({
                    ok: true,
                    value: createTestHandlerContext<ValidateAuthValue>({
                      audit: NO_AUDIT,
                      safeDb: NO_DB,
                      scopedDb: NO_DB,
                      featureAccessSnapshot: context.featureAccessSnapshot,
                    }),
                  }),
                }),
              )
              .post(
                "/",
                () => {
                  executions += 1;
                  return "served";
                },
                { body: t.Object({ required: t.String() }) },
              );
            for (const body of ["{}", '{"required":"valid"}']) {
              const response = await route.handle(
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
      for (const enabled of [false, true]) {
        for (const enrolled of [false, true]) {
          await withDeployment(feature.flag, enabled, async () => {
            const context = contextFor(feature.id, enrolled);
            const omittedCapabilities = await featureOmittedCapabilityIds(
              undefined,
              context,
            );
            const listed = await handleMcpToolCall({
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
              expect(omittedCapabilities).not.toContain(capability);
              const result = await handleMcpToolCall({
                toolName: "invoke_capability",
                args: { capability, input: {} },
                context: { ...context, grantedScopes: [] },
              });
              if (!enabled || !enrolled) {
                expect(errorCodeOf(result)).toBe("not_found");
              } else {
                expect(errorCodeOf(result)).not.toBe("not_found");
              }
            }
          });
        }
      }
    });
  });
}
