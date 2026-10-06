import type { CallToolResult } from "@modelcontextprotocol/server";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import type { AnyElysia } from "elysia";
import * as v from "valibot";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { listsRoute } from "@/api/handlers/lists/routes";
import { numberSeriesRoute } from "@/api/handlers/number-series/routes";
import { readDeploymentFeatures } from "@/api/handlers/organization-settings/deployment-features/get";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { savedTimeNarrativesRoute } from "@/api/handlers/saved-time-narratives/routes";
import { sellerProfilesRoute } from "@/api/handlers/seller-profiles/routes";
import { timeApprovalQueueRoute } from "@/api/handlers/time-entries/approval-queue/routes";
import { internalTimeEntriesRoute } from "@/api/handlers/time-entries/internal/routes";
import { myTimeEntriesRoute } from "@/api/handlers/time-entries/me/routes";
import { memberTimeTargetsRoute } from "@/api/handlers/time-entries/members/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { timeTimersRoute } from "@/api/handlers/time-timers/routes";
import { vatRateRoute } from "@/api/handlers/vat-rates/routes";
import type { ValidateAuthValue } from "@/api/lib/auth";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import { featureOmittedCapabilityIds } from "@/api/mcp/capability-tools";
import { MCP_ALL_RESOURCE_SCOPES, MCP_MODES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { mcpOmittedToolNamesByReason } from "@/api/mcp/server-core";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { FEATURE_DISABLED_MESSAGE } from "@/api/mcp/tool-utils";
import { getMcpToolDefinition, handleMcpToolCall } from "@/api/mcp/tools";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const FLAG = "FEATURE_TIME_BILLING";
const FEATURE_ID = "time-billing";
const ORGANIZATION_ID = "org_test";
const USER_ID = "user_test";
const PATH_ID = "00000000-0000-4000-8000-000000000001";
const CALLER = { organizationId: ORGANIZATION_ID, userId: USER_ID };

const snapshotFor = (enabled: boolean, deploymentEnabled = true) =>
  createFeatureAccessSnapshot({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    decisions: new Map([
      [
        FEATURE_ID,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: FEATURE_ID,
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          membership: true,
          user: { email: "member@example.test", emailVerified: true },
          grants: {},
          enrolments: enabled
            ? [
                {
                  userId: USER_ID,
                  organizationId: ORGANIZATION_ID,
                  featureId: FEATURE_ID,
                },
              ]
            : [],
          deploymentEnabled,
        }),
      ],
    ]),
  });
const enrolledContext = () =>
  asTestRaw<McpRequestContext>({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    featureAccessSnapshot: snapshotFor(true),
    accessibleWorkspaceIds: [PATH_ID],
    grantedScopes: MCP_ALL_RESOURCE_SCOPES,
    // An owner sees every billing tool, so enrolment is the only variable.
    memberRole: "owner",
  });

const TIME_BILLING_ROUTES: Readonly<Record<string, AnyElysia>> = {
  billingCodesRoute,
  expensesRoute,
  internalTimeEntriesRoute,
  invoicesRoute,
  memberTimeTargetsRoute,
  myTimeEntriesRoute,
  numberSeriesRoute,
  ratesRoute,
  savedTimeNarrativesRoute,
  sellerProfilesRoute,
  timeApprovalQueueRoute,
  timeEntriesRoute,
  timeTimersRoute,
  vatRateRoute,
};

/**
 * Runs `run` as a deployed (strict) process with the flag set, restoring both
 * afterwards. Local development serves the feature whatever the flag says, so
 * strict mode is what makes the flag decide.
 */
const withTimeBilling = async <T>(
  enabled: boolean,
  run: () => Promise<T>,
): Promise<T> => {
  const previous = env[FLAG];
  env[FLAG] = enabled;
  const restoreRuntimeMode = setRuntimeModeForTesting({
    mode: RUNTIME_MODE.strict,
  });
  try {
    return await run();
  } finally {
    env[FLAG] = previous;
    restoreRuntimeMode();
  }
};

const requestsFor = (route: AnyElysia): Request[] =>
  route.routes.map(
    ({ method, path }) =>
      new Request(
        `http://localhost${path.replaceAll(/:[A-Za-z]+/gu, () => PATH_ID)}`,
        { method },
      ),
  );

const describeResponse = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
});

/** What another flagged route group answers while its own flag is off. */
const disabledFlagResponse = async () => {
  const previous = env.FEATURE_LEGAL_LISTS;
  env.FEATURE_LEGAL_LISTS = false;
  const restoreRuntimeMode = setRuntimeModeForTesting({
    mode: RUNTIME_MODE.strict,
  });
  try {
    return await describeResponse(
      await listsRoute.handle(new Request(`http://localhost/lists/${PATH_ID}`)),
    );
  } finally {
    env.FEATURE_LEGAL_LISTS = previous;
    restoreRuntimeMode();
  }
};

const errorOf = (result: CallToolResult) => {
  const item = result.content.at(0);
  const parsed = v.safeParse(
    v.object({ error: v.object({ code: v.string(), message: v.string() }) }),
    item?.type === "text" ? JSON.parse(item.text) : null,
  );
  return parsed.success
    ? { code: parsed.output.error.code, message: parsed.output.error.message }
    : { code: "none", message: "none" };
};

const timeBillingToolNames = (mode: (typeof MCP_MODES)[number]) =>
  listStaticMcpToolDefinitions(mode)
    .filter((definition) => definition.feature === FLAG)
    .map((definition) => definition.name)
    .toSorted();

describe("time billing admission census", () => {
  test("every deployment-gated route group is exercised and every owned handler requires enrolment", async () => {
    const routeNames: string[] = [];
    for (const filename of new Glob("**/routes.ts").scanSync(import.meta.dir)) {
      const source = await Bun.file(`${import.meta.dir}/${filename}`).text();
      if (!source.includes('"FEATURE_TIME_BILLING"')) {
        continue;
      }
      expect(source).toContain('.use(featureAccessGate("time-billing"))');
      const name = /export const (\w+) =/u.exec(source)?.at(1);
      expect(name).toBeDefined();
      if (name !== undefined) {
        routeNames.push(name);
      }
    }
    expect(routeNames.toSorted()).toEqual(
      Object.keys(TIME_BILLING_ROUTES).toSorted(),
    );

    for (const directory of FEATURE_REGISTRY[FEATURE_ID].ownership
      .handlerDirectories) {
      const absolute = `${import.meta.dir}/../../../../${directory}`;
      for (const filename of new Glob("**/*.ts").scanSync(absolute)) {
        if (filename.endsWith(".test.ts")) {
          continue;
        }
        const source = await Bun.file(`${absolute}/${filename}`).text();
        if (filename === "routes.ts" || filename.endsWith("/routes.ts")) {
          expect(source).toContain(
            'isDeploymentFeatureEnabled("FEATURE_TIME_BILLING")',
          );
          expect(source).toContain('.use(featureAccessGate("time-billing"))');
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
          featureId: FEATURE_ID,
          type: "required",
        });
      }
    }
    for (const mode of MCP_MODES) {
      for (const definition of listStaticMcpToolDefinitions(mode)) {
        if (definition.feature === FLAG) {
          expect(definition.featureId).toBe(FEATURE_ID);
        }
      }
    }
  });

  test("unavailable decisions hide malformed requests before validation and enrolled callers reach the handler", async () => {
    for (const deploymentEnabled of [false, true]) {
      for (const enrolled of [false, true]) {
        const snapshot = snapshotFor(enrolled, deploymentEnabled);
        let executions = 0;
        const route = new Elysia()
          .use(
            featureAccessGate(FEATURE_ID, {
              resolveAuth: async () => ({
                ok: true,
                value: createTestHandlerContext<ValidateAuthValue>({
                  featureAccessSnapshot: snapshot,
                  // The member lookup already decided feature access: the
                  // gate itself must not open a transaction or query.
                  safeDb: async () => {
                    throw new Error("the feature-access gate queried");
                  },
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
            {
              body: t.Object({ required: t.String() }),
            },
          );
        const send = async (body: string) =>
          await route.handle(
            new Request("http://localhost/", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          );
        const visible = deploymentEnabled && enrolled;
        expect((await send("{}")).status).toBe(visible ? 422 : 404);
        expect((await send('{"required":"valid"}')).status).toBe(
          visible ? 200 : 404,
        );
        expect(executions).toBe(visible ? 1 : 0);
      }
    }
  });
});

describe("time billing over REST", () => {
  test.each(Object.entries(TIME_BILLING_ROUTES))(
    "%s answers every route like any disabled flagged route while the flag is off",
    async (_name, route) => {
      const disabled = await disabledFlagResponse();
      expect(disabled.status).toBe(404);
      const requests = requestsFor(route);
      expect(requests.length).toBeGreaterThan(0);

      const responses = await withTimeBilling(false, async () =>
        Promise.all(
          requests.map(async (request) =>
            describeResponse(await route.handle(request)),
          ),
        ),
      );

      for (const response of responses) {
        expect(response).toEqual(disabled);
      }
    },
  );

  test.each(Object.entries(TIME_BILLING_ROUTES))(
    "%s hides every route from unauthenticated callers once the flag is on",
    async (_name, route) => {
      const requests = requestsFor(route);

      const statuses = await withTimeBilling(true, async () =>
        Promise.all(
          requests.map(async (request) => (await route.handle(request)).status),
        ),
      );

      // No authenticated principal can hold a feature enrolment.
      for (const status of statuses) {
        expect(status).toBe(404);
      }
    },
  );
});

describe("time billing on agent surfaces", () => {
  test("tool discovery requires the caller's own enrolment in the current organization", async () => {
    await withTimeBilling(true, async () => {
      for (const mode of MCP_MODES) {
        for (const toolName of timeBillingToolNames(mode)) {
          expect(
            await getMcpToolDefinition(toolName, enrolledContext(), mode),
          ).toBeDefined();
          for (const context of [
            { ...enrolledContext(), featureAccessSnapshot: snapshotFor(false) },
            { ...enrolledContext(), userId: "colleague" },
            { ...enrolledContext(), organizationId: "another_organization" },
          ]) {
            expect(
              await getMcpToolDefinition(
                toolName,
                asTestRaw<McpRequestContext>(context),
                mode,
              ),
            ).toBeUndefined();
            const result = await handleMcpToolCall({
              toolName,
              args: {},
              context: asTestRaw<McpRequestContext>(context),
              mode,
            });
            expect(errorOf(result).code).toBe("unknown_tool");
          }
        }
      }
    });
  });

  test("the tool list the CLI builds from omits every time billing tool and capability while the flag is off", async () => {
    const expectedCapabilities = await featureOmittedCapabilityIds(
      (feature) => feature !== FLAG,
      enrolledContext(),
    );
    expect(expectedCapabilities).toContain("time-entries.create");
    expect(expectedCapabilities).toContain("invoices.create");

    await withTimeBilling(false, async () => {
      for (const mode of MCP_MODES) {
        const omitted = mcpOmittedToolNamesByReason({
          context: enrolledContext(),
          grantedScopes: MCP_ALL_RESOURCE_SCOPES,
          mode,
        });
        for (const name of timeBillingToolNames(mode)) {
          expect(omitted.feature).toContain(name);
        }
      }
      expect(timeBillingToolNames("default").length).toBeGreaterThan(0);
      const omittedCapabilities = await featureOmittedCapabilityIds(
        undefined,
        enrolledContext(),
      );
      for (const id of expectedCapabilities) {
        expect(omittedCapabilities).toContain(id);
      }
    });
  });

  test("the tool list offers every time billing tool and capability once the flag is on", async () => {
    await withTimeBilling(true, async () => {
      for (const mode of MCP_MODES) {
        const omitted = mcpOmittedToolNamesByReason({
          context: enrolledContext(),
          grantedScopes: MCP_ALL_RESOURCE_SCOPES,
          mode,
        });
        for (const name of timeBillingToolNames(mode)) {
          expect(omitted.feature).not.toContain(name);
        }
      }
      const omittedCapabilities = await featureOmittedCapabilityIds(
        undefined,
        enrolledContext(),
      );
      const offTimeBilling = await featureOmittedCapabilityIds(
        (feature) => feature !== FLAG,
        enrolledContext(),
      );
      for (const id of offTimeBilling) {
        expect(omittedCapabilities).not.toContain(id);
      }
    });
  });

  // The REST gate is a route hook invoke_capability does not pass through; the
  // catalog's feature tag is what refuses a guessed id.
  test("invoke_capability refuses every time billing capability while the flag is off and passes it on once on", async () => {
    const capabilities = await featureOmittedCapabilityIds(
      (feature) => feature !== FLAG,
      enrolledContext(),
    );
    expect(capabilities).toContain("invoices.list");
    expect(capabilities).toContain("invoices.pdf.export");

    const refusalWith = async (enabled: boolean, capability: string) =>
      await withTimeBilling(enabled, async () =>
        errorOf(
          await handleMcpToolCall({
            args: { capability, input: {} },
            context: { ...enrolledContext(), grantedScopes: [] },
            toolName: "invoke_capability",
          }),
        ),
      );

    for (const capability of capabilities) {
      expect({
        capability,
        error: await refusalWith(false, capability),
      }).toEqual({
        capability,
        error: { code: "feature_disabled", message: FEATURE_DISABLED_MESSAGE },
      });
      // Past the flag, a later gate (transport or the empty grant's scope)
      // answers instead.
      expect({
        capability,
        message: (await refusalWith(true, capability)).message,
      }).not.toEqual({ capability, message: FEATURE_DISABLED_MESSAGE });
    }
  });
});

describe("time billing for the web client", () => {
  test("the deployment features answer follows the flag the routes follow", async () => {
    for (const enabled of [false, true]) {
      const features = await withTimeBilling(enabled, async () =>
        readDeploymentFeatures({
          principal: CALLER,
          snapshot: snapshotFor(true, enabled),
        }),
      );
      expect(features.timeBilling).toBe(enabled);
    }
  });

  test("the deployment features answer is off for a caller who has not enrolled", async () => {
    const features = await withTimeBilling(true, async () =>
      readDeploymentFeatures({
        principal: CALLER,
        snapshot: snapshotFor(false),
      }),
    );
    expect(features.timeBilling).toBe(false);
  });

  test("an enrolled snapshot resolved for another caller enables nothing", async () => {
    for (const principal of [
      { organizationId: ORGANIZATION_ID, userId: "user_other" },
      { organizationId: "org_other", userId: USER_ID },
      { organizationId: ORGANIZATION_ID, userId: null },
    ]) {
      const features = await withTimeBilling(true, async () =>
        readDeploymentFeatures({ principal, snapshot: snapshotFor(true) }),
      );
      expect({ principal, timeBilling: features.timeBilling }).toEqual({
        principal,
        timeBilling: false,
      });
    }
  });

  test("the deployment features route is served whatever the flag says", async () => {
    for (const enabled of [false, true]) {
      const response = await withTimeBilling(
        enabled,
        async () =>
          await organizationSettingsRoute.handle(
            new Request(
              "http://localhost/organization-settings/deployment-features",
            ),
          ),
      );
      // An unauthenticated probe stops at authentication, never at a flag.
      expect(response.status).toBe(401);
    }
  });
});
