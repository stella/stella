import { describe, expect, test } from "bun:test";
import type { AnyElysia } from "elysia";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { listsRoute } from "@/api/handlers/lists/routes";
import { readDeploymentFeatures } from "@/api/handlers/organization-settings/deployment-features/get";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { savedTimeNarrativesRoute } from "@/api/handlers/saved-time-narratives/routes";
import { timeApprovalQueueRoute } from "@/api/handlers/time-entries/approval-queue/routes";
import { internalTimeEntriesRoute } from "@/api/handlers/time-entries/internal/routes";
import { myTimeEntriesRoute } from "@/api/handlers/time-entries/me/routes";
import { memberTimeTargetsRoute } from "@/api/handlers/time-entries/members/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { timeTimersRoute } from "@/api/handlers/time-timers/routes";
import { featureOmittedCapabilityIds } from "@/api/mcp/capability-tools";
import { MCP_ALL_RESOURCE_SCOPES, MCP_MODES } from "@/api/mcp/constants";
import { mcpOmittedToolNamesByReason } from "@/api/mcp/server-core";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const FLAG = "FEATURE_TIME_BILLING";
const PATH_ID = "00000000-0000-4000-8000-000000000001";

const TIME_BILLING_ROUTES: Readonly<Record<string, AnyElysia>> = {
  billingCodesRoute,
  expensesRoute,
  internalTimeEntriesRoute,
  invoicesRoute,
  memberTimeTargetsRoute,
  myTimeEntriesRoute,
  ratesRoute,
  savedTimeNarrativesRoute,
  timeApprovalQueueRoute,
  timeEntriesRoute,
  timeTimersRoute,
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

const timeBillingToolNames = (mode: (typeof MCP_MODES)[number]) =>
  listStaticMcpToolDefinitions(mode)
    .filter((definition) => definition.feature === FLAG)
    .map((definition) => definition.name)
    .toSorted();

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
    "%s serves every route once the flag is on",
    async (_name, route) => {
      const requests = requestsFor(route);

      const statuses = await withTimeBilling(true, async () =>
        Promise.all(
          requests.map(async (request) => (await route.handle(request)).status),
        ),
      );

      // Unauthenticated probes: the route answers past the flag check
      // (authentication or validation), never the disabled 404.
      for (const status of statuses) {
        expect(status).not.toBe(404);
      }
    },
  );
});

describe("time billing on agent surfaces", () => {
  test("the tool list the CLI builds from omits every time billing tool and capability while the flag is off", async () => {
    const expectedCapabilities = await featureOmittedCapabilityIds(
      (feature) => feature !== FLAG,
    );
    expect(expectedCapabilities).toContain("time-entries.create");
    expect(expectedCapabilities).toContain("invoices.create");

    await withTimeBilling(false, async () => {
      for (const mode of MCP_MODES) {
        const omitted = mcpOmittedToolNamesByReason({
          grantedScopes: MCP_ALL_RESOURCE_SCOPES,
          mode,
        });
        for (const name of timeBillingToolNames(mode)) {
          expect(omitted.feature).toContain(name);
        }
      }
      expect(timeBillingToolNames("default").length).toBeGreaterThan(0);
      const omittedCapabilities = await featureOmittedCapabilityIds();
      for (const id of expectedCapabilities) {
        expect(omittedCapabilities).toContain(id);
      }
    });
  });

  test("the tool list offers every time billing tool and capability once the flag is on", async () => {
    await withTimeBilling(true, async () => {
      for (const mode of MCP_MODES) {
        const omitted = mcpOmittedToolNamesByReason({
          grantedScopes: MCP_ALL_RESOURCE_SCOPES,
          mode,
        });
        for (const name of timeBillingToolNames(mode)) {
          expect(omitted.feature).not.toContain(name);
        }
      }
      const omittedCapabilities = await featureOmittedCapabilityIds();
      const offTimeBilling = await featureOmittedCapabilityIds(
        (feature) => feature !== FLAG,
      );
      for (const id of offTimeBilling) {
        expect(omittedCapabilities).not.toContain(id);
      }
    });
  });
});

describe("time billing for the web client", () => {
  test("the deployment features answer follows the flag the routes follow", async () => {
    for (const enabled of [false, true]) {
      const features = await withTimeBilling(enabled, async () =>
        readDeploymentFeatures(),
      );
      expect(features.timeBilling).toBe(enabled);
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
