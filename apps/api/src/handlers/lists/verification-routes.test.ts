import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { listsRoute } from "@/api/handlers/lists/routes";
import { createListVerificationRoutes } from "@/api/handlers/lists/verification-routes";
import { createHttpApp } from "@/api/http/app";
import { mount, routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import type { ValidateAuthValue } from "@/api/lib/auth";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { isRecord } from "@/api/lib/type-guards";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { serveForTest } from "@/api/tests/helpers/test-server";

const FEATURE_ID = "list-verification";
const principal = { organizationId: "org_test", userId: "user_test" };

type RouteGrantOptions = {
  verificationEnabled: boolean;
  listsEnabled?: boolean;
};

/**
 * The verification routes as the lists group mounts them, with the feature
 * gate reading a member whose grants the test decides.
 */
const routeFor = ({
  verificationEnabled: enabled,
  listsEnabled = true,
}: RouteGrantOptions): RouteEntry[] => {
  const snapshot = createFeatureAccessSnapshot({
    ...principal,
    decisions: new Map([
      [
        FEATURE_ID,
        decideFeatureAccess({
          ...principal,
          featureId: FEATURE_ID,
          registry: FEATURE_REGISTRY,
          user: { email: "member@example.test", emailVerified: true },
          membership: true,
          grants: {
            "legal-lists": listsEnabled
              ? [
                  {
                    type: "organization",
                    organizationId: principal.organizationId,
                  },
                ]
              : [],
            [FEATURE_ID]: enabled
              ? [
                  {
                    type: "organization",
                    organizationId: principal.organizationId,
                  },
                ]
              : [],
          },
        }),
      ],
    ]),
  });
  return mount(
    [
      createListVerificationRoutes({
        resolveAuth: async () => ({
          ok: true,
          value: createTestHandlerContext<ValidateAuthValue>({
            audit: NO_AUDIT,
            safeDb: NO_DB,
            scopedDb: NO_DB,
            featureAccessSnapshot: snapshot,
          }),
        }),
      }),
    ],
    { prefix: "/lists/:workspaceId" },
  );
};

const serve = (entries: readonly RouteEntry[]) =>
  serveForTest(createHttpApp({ routes: entries, middleware: [errorBoundary] }));

const malformedRequestFor = ({ method, path }: RouteEntry): Request => {
  const url = `http://localhost${path.replaceAll(/:[A-Za-z]+/gu, () => "invalid-id")}`;
  return method === "GET"
    ? new Request(url, { method })
    : new Request(url, {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
};

describe("list verification route admission", () => {
  test("every verification handler is mounted behind admission", async () => {
    const handlers: string[] = [];
    const mounted = routeFor({ verificationEnabled: false });
    for (const filename of new Glob("**/*.ts").scanSync(import.meta.dir)) {
      if (filename.endsWith(".test.ts")) {
        continue;
      }
      const source = await Bun.file(`${import.meta.dir}/${filename}`).text();
      if (!source.includes("featureAccess:")) {
        continue;
      }
      const module: unknown = await import(`${import.meta.dir}/${filename}`);
      expect(isRecord(module)).toBe(true);
      if (!isRecord(module)) {
        continue;
      }
      const definition = module["default"];
      expect(isRecord(definition)).toBe(true);
      if (!isRecord(definition)) {
        continue;
      }
      const config = definition["config"];
      expect(isRecord(config)).toBe(true);
      if (!isRecord(config)) {
        continue;
      }
      const featureAccess = config["featureAccess"];
      expect(isRecord(featureAccess)).toBe(true);
      if (
        !isRecord(featureAccess) ||
        featureAccess["featureId"] !== FEATURE_ID ||
        featureAccess["type"] !== "required"
      ) {
        continue;
      }
      expect(typeof definition["handler"]).toBe("function");
      expect(mounted.some((entry) => entry.definition === definition)).toBe(
        true,
      );
      handlers.push(filename);
    }
    expect(handlers).toHaveLength(mounted.length);
    expect(handlers).toHaveLength(13);
  });

  // The gate answers like an absent route (404) before the route reads
  // anything. An admitted request reaches the route itself, whose own member
  // authentication runs before its input is read: without a session it
  // answers 401, never the gate's 404.
  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "verification grant %s and list grant %s determine whether malformed requests reach the route",
    async (enabled, listsEnabled) => {
      const entries = routeFor({ verificationEnabled: enabled, listsEnabled });
      await using server = serve(entries);
      for (const entry of entries) {
        const response = await server.fetch(malformedRequestFor(entry));
        expect({
          route: `${entry.method} ${entry.path}`,
          status: response.status,
        }).toEqual({
          route: `${entry.method} ${entry.path}`,
          status: enabled && listsEnabled ? 401 : 404,
        });
      }
    },
  );

  test("the production lists mount hides verification routes and serves shared source creation", async () => {
    const previous = env.FEATURE_LEGAL_LISTS;
    env.FEATURE_LEGAL_LISTS = true;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    try {
      await using server = serve(listsRoute);
      for (const entry of routeFor({ verificationEnabled: false })) {
        expect((await server.fetch(malformedRequestFor(entry))).status).toBe(
          404,
        );
      }
      // The sibling route is mounted and admits the request to its own
      // authentication, which runs before its input is validated.
      const sibling = await server.fetch(
        new Request("http://localhost/lists/invalid-id/item-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(sibling.status).toBe(401);
    } finally {
      env.FEATURE_LEGAL_LISTS = previous;
      restoreRuntimeMode();
    }
  });

  test("admission remains local to verification routes", async () => {
    await using server = serve([
      ...routeFor({ verificationEnabled: false }),
      ...routes({
        "/ordinary": { GET: defineEndpoint.public({}, () => "served") },
      }),
    ]);
    const response = await server.fetch(
      new Request("http://localhost/ordinary"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("served");
  });
});
