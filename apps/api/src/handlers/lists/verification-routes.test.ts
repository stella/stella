import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { listsRoute } from "@/api/handlers/lists/routes";
import { createListVerificationRoutes } from "@/api/handlers/lists/verification-routes";
import type { ValidateAuthValue } from "@/api/lib/auth";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const FEATURE_ID = "list-verification";
const principal = { organizationId: "org_test", userId: "user_test" };

const routeFor = (enabled: boolean) => {
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
          grants: enabled
            ? {
                [FEATURE_ID]: [
                  {
                    type: "organization",
                    organizationId: principal.organizationId,
                  },
                ],
              }
            : {},
        }),
      ],
    ]),
  });
  return new Elysia({ prefix: "/lists/:workspaceId" })
    .use(workspaceAccessMacro)
    .use(permissionMacro)
    .guard({ validateWorkspaceAccess: true })
    .use(
      createListVerificationRoutes({
        resolveAuth: async () => ({
          ok: true,
          value: createTestHandlerContext<ValidateAuthValue>({
            featureAccessSnapshot: snapshot,
          }),
        }),
      }),
    );
};

describe("list verification route admission", () => {
  test("every verification handler is mounted behind admission", async () => {
    const handlers: string[] = [];
    for (const filename of new Glob("**/*.ts").scanSync(import.meta.dir)) {
      if (filename.endsWith(".test.ts")) {
        continue;
      }
      const source = await Bun.file(`${import.meta.dir}/${filename}`).text();
      if (!source.includes("featureAccess:")) {
        continue;
      }
      const module = await import(`${import.meta.dir}/${filename}`);
      expect(isRecord(module.default)).toBe(true);
      if (!isRecord(module.default)) {
        continue;
      }
      const config = module.default.config;
      expect(isRecord(config)).toBe(true);
      if (!isRecord(config)) {
        continue;
      }
      const featureAccess = config["featureAccess"];
      expect(isRecord(featureAccess)).toBe(true);
      if (
        !isRecord(featureAccess) ||
        featureAccess["featureId"] !== FEATURE_ID
      ) {
        continue;
      }
      const handler = module.default.handler;
      expect(typeof handler).toBe("function");
      expect(
        routeFor(false).routes.some((route) => route.handler === handler),
      ).toBe(true);
      handlers.push(filename);
    }
    expect(handlers).toHaveLength(routeFor(false).routes.length);
    expect(handlers).toHaveLength(8);
  });

  test.each([false, true])(
    "grant %s determines whether malformed requests reach validation",
    async (enabled) => {
      const route = routeFor(enabled);
      for (const { method, path } of route.routes) {
        const url = `http://localhost${path.replaceAll(/:[A-Za-z]+/gu, () => "invalid-id")}`;
        const request =
          method === "GET"
            ? new Request(url, { method })
            : new Request(url, {
                method,
                headers: { "content-type": "application/json" },
                body: "{}",
              });
        const response = await route.handle(request);
        expect(response.status).toBe(enabled ? 422 : 404);
      }
    },
  );

  test("the production lists mount hides verification routes and validates shared source creation", async () => {
    const previous = env.FEATURE_LEGAL_LISTS;
    env.FEATURE_LEGAL_LISTS = true;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: RUNTIME_MODE.strict,
    });
    try {
      const app = new Elysia().use(listsRoute);
      for (const { method, path } of routeFor(false).routes) {
        const url = `http://localhost${path.replaceAll(/:[A-Za-z]+/gu, () => "invalid-id")}`;
        const request =
          method === "GET"
            ? new Request(url, { method })
            : new Request(url, {
                method,
                headers: { "content-type": "application/json" },
                body: "{}",
              });
        expect((await app.handle(request)).status).toBe(404);
      }
      const sibling = await app.handle(
        new Request("http://localhost/lists/invalid-id/item-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(sibling.status).toBe(422);
    } finally {
      env.FEATURE_LEGAL_LISTS = previous;
      restoreRuntimeMode();
    }
  });

  test("admission remains local to verification routes", async () => {
    const app = new Elysia()
      .use(routeFor(false))
      .get("/ordinary", () => "served");
    expect(
      (await app.handle(new Request("http://localhost/ordinary"))).status,
    ).toBe(200);
  });
});
