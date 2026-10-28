import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { apiRoutes } from "@/api/api-routes";
import { env } from "@/api/env";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { clientInvoicesRoute } from "@/api/handlers/client-invoices/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { listsRoute } from "@/api/handlers/lists/routes";
import { numberSeriesRoute } from "@/api/handlers/number-series/routes";
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
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import { featureAccessSnapshotFromAuthorization } from "@/api/lib/auth";
import type { ValidateAuthValue } from "@/api/lib/auth";
import {
  featureAccessGate,
  featureAccessGateFeature,
} from "@/api/lib/auth/feature-access/route";
import { toSafeId } from "@/api/lib/branded-types";
import { deploymentFeatureGateFlag } from "@/api/lib/deployment-feature-route";
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
import { MCP_ALL_RESOURCE_SCOPES, MCP_MODES } from "@/api/mcp/constants";
import { mcpOmittedToolNamesByReason } from "@/api/mcp/server-core";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { FEATURE_DISABLED_MESSAGE } from "@/api/mcp/tool-utils";
import { getMcpToolDefinition, handleMcpToolCall } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const capabilityCatalog = parseCatalog(readCapabilityCatalog());

const FLAG = "FEATURE_TIME_BILLING";
const FEATURE_ID = "time-billing";
const ORGANIZATION_ID = "org_test";
const USER_ID = "user_test";
const PATH_ID = "00000000-0000-4000-8000-000000000001";

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
  asTestRaw<AuthorizedMcpRequestContext>({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    featureAccessSnapshot: snapshotFor(true),
    accessibleWorkspaceIds: [PATH_ID],
    grantedScopes: MCP_ALL_RESOURCE_SCOPES,
    // An owner sees every billing tool, so enrolment is the only variable.
    memberRole: "owner",
  });

const TIME_BILLING_ROUTES: Readonly<Record<string, readonly RouteEntry[]>> = {
  billingCodesRoute,
  expensesRoute,
  internalTimeEntriesRoute,
  invoicesRoute,
  clientInvoicesRoute,
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

/** A route group served on its own, with the production error answers. */
const serveRoutes = (entries: readonly RouteEntry[]) =>
  serveForTest(createHttpApp({ routes: entries, middleware: [errorBoundary] }));

/**
 * The flag decides only in a deployed process, and the deployment gate is the
 * group's outermost stage, ahead of the feature-access gate: a disabled flag
 * hides the routes before any member lookup.
 */
/**
 * Whether a mounted route is hidden by the deployment flag first, then by the
 * feature's enrolment: read from the gates the route actually runs.
 */
const hasTimeBillingGates = ({ middleware }: RouteEntry): boolean => {
  const deployment = middleware.findIndex(
    (stage) => deploymentFeatureGateFlag(stage) === FLAG,
  );
  const enrolment = middleware.findIndex(
    (stage) => featureAccessGateFeature(stage) === FEATURE_ID,
  );
  return deployment !== -1 && enrolment > deployment;
};

const requestsFor = (route: readonly RouteEntry[]): Request[] =>
  route.map(
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
    await using server = serveRoutes(listsRoute);
    return await describeResponse(
      await server.fetch(new Request(`http://localhost/lists/${PATH_ID}`)),
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
    // Every served route behind the flag is in the census, and every census
    // route is behind both gates, the flag first.
    const census = Object.values(TIME_BILLING_ROUTES).flat();
    const flagged = apiRoutes.filter(({ middleware }) =>
      middleware.some((stage) => deploymentFeatureGateFlag(stage) === FLAG),
    );
    expect(flagged.length).toBeGreaterThan(0);
    // A group's paths lack the mount prefix; its definitions are the same
    // objects the served table carries.
    const censusDefinitions = new Set(
      census.map(({ definition }) => definition),
    );
    expect(
      flagged.filter(({ definition }) => !censusDefinitions.has(definition)),
    ).toEqual([]);
    expect(flagged).toHaveLength(census.length);
    expect(census.filter((entry) => !hasTimeBillingGates(entry))).toEqual([]);

    for (const directory of FEATURE_REGISTRY[FEATURE_ID].ownership
      .handlerDirectories) {
      const absolute = `${import.meta.dir}/../../../../${directory}`;
      for (const filename of new Glob("**/*.ts").scanSync(absolute)) {
        if (filename.endsWith(".test.ts")) {
          continue;
        }
        const source = await Bun.file(`${absolute}/${filename}`).text();
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
              featureAccessGate(FEATURE_ID, {
                resolveAuth: async () => ({
                  ok: true,
                  value: createTestHandlerContext<ValidateAuthValue>({
                    audit: NO_AUDIT,
                    scopedDb: NO_DB,
                    featureAccessSnapshot: snapshot,
                    // The member lookup already decided feature access: the
                    // gate itself must not open a transaction or query.
                    safeDb: async () => {
                      throw new Error("the feature-access gate queried");
                    },
                  }),
                }),
              }),
            ],
          },
        );
        await using server = serveRoutes(route);
        const send = async (body: string) =>
          await server.fetch(
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

      await using server = serveRoutes(route);
      const responses = await withTimeBilling(false, async () =>
        Promise.all(
          requests.map(async (request) =>
            describeResponse(await server.fetch(request)),
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

      await using server = serveRoutes(route);
      const statuses = await withTimeBilling(true, async () =>
        Promise.all(
          requests.map(async (request) => (await server.fetch(request)).status),
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
                asTestRaw<AuthorizedMcpRequestContext>(context),
                mode,
              ),
            ).toBeUndefined();
            const result = await handleMcpToolCall({
              toolName,
              args: {},
              context: asTestRaw<AuthorizedMcpRequestContext>(context),
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
    expect(expectedCapabilities).toContain("client-invoices.create");
    expect(expectedCapabilities).toContain("client-invoices.prefill");

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

  // The REST gate is route middleware capability executors do not pass through; the
  // catalog's feature tag is what refuses a guessed id.
  test("capability executors refuse every time billing capability while the flag is off and passes it on once on", async () => {
    const capabilities = await featureOmittedCapabilityIds(
      (feature) => feature !== FLAG,
      enrolledContext(),
    );
    expect(capabilities).toContain("invoices.list");
    expect(capabilities).toContain("invoices.pdf.export");

    const refusalWith = async (enabled: boolean, capability: string) => {
      const entry = capabilityCatalog.find(
        (candidate) => candidate.id === capability,
      );
      const access = entry?.access;
      if (access !== "read" && access !== "write") {
        panic("Test capability access is not registered");
      }
      return await withTimeBilling(enabled, async () =>
        errorOf(
          await handleMcpToolCall({
            args: { capability, input: {} },
            mode: "advanced",
            context: { ...enrolledContext(), grantedScopes: [] },
            toolName: MCP_CAPABILITY_EXECUTORS[access],
          }),
        ),
      );
    };

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

describe("feature access from the request's member lookup", () => {
  const organizationId = toSafeId<"organization">(ORGANIZATION_ID);
  const userId = toSafeId<"user">(USER_ID);
  // What the standalone resolver decides from the same facts: a deleted
  // account has no identity and no enrolments.
  const resolverDecision = ({
    deleted,
    verified,
    enrolled,
  }: {
    deleted: boolean;
    verified: boolean;
    enrolled: boolean;
  }) =>
    decideFeatureAccess({
      registry: FEATURE_REGISTRY,
      featureId: FEATURE_ID,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      membership: !deleted,
      user: deleted
        ? null
        : { email: "member@example.test", emailVerified: verified },
      grants: {},
      enrolments:
        deleted || !enrolled
          ? []
          : [
              {
                userId: USER_ID,
                organizationId: ORGANIZATION_ID,
                featureId: FEATURE_ID,
              },
            ],
      deploymentEnabled: true,
    });

  test("matches the standalone resolver for enrolled, unverified, unenrolled and deleted callers", async () => {
    for (const deleted of [false, true]) {
      for (const verified of [false, true]) {
        for (const enrolled of [false, true]) {
          const snapshot = await withTimeBilling(true, async () =>
            featureAccessSnapshotFromAuthorization({
              organizationId,
              userId,
              authorization: {
                email: "member@example.test",
                emailVerified: verified,
                userDeleted: deleted,
                enrolledFeatureIds: enrolled ? [FEATURE_ID] : [],
              },
            }),
          );
          expect({
            deleted,
            verified,
            enrolled,
            decision: snapshot.decisions.get(FEATURE_ID),
          }).toEqual({
            deleted,
            verified,
            enrolled,
            decision: resolverDecision({ deleted, verified, enrolled }),
          });
        }
      }
    }
  });

  test("a deleted account keeps no enrolment, so it is never enabled", async () => {
    const snapshot = await withTimeBilling(true, async () =>
      featureAccessSnapshotFromAuthorization({
        organizationId,
        userId,
        authorization: {
          email: "member@example.test",
          emailVerified: true,
          userDeleted: true,
          enrolledFeatureIds: [FEATURE_ID],
        },
      }),
    );
    expect(snapshot.decisions.get(FEATURE_ID)?.status).not.toBe("enabled");
  });
});
