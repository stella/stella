import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
});

const originalFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return Response.json(null);
  },
  { preconnect: () => undefined },
);

const { QueryClient } = await import("@tanstack/react-query");
const { isRedirect } = await import("@tanstack/react-router");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const routeModule: unknown = await import("./route");

const readAdmission = () => {
  if (
    typeof routeModule !== "object" ||
    routeModule === null ||
    !("Route" in routeModule)
  ) {
    throw new TypeError("Missing admin route export");
  }
  const route = routeModule.Route;
  if (typeof route !== "object" || route === null || !("options" in route)) {
    throw new TypeError("Missing admin route options");
  }
  const options = route.options;
  if (
    typeof options !== "object" ||
    options === null ||
    !("beforeLoad" in options) ||
    typeof options.beforeLoad !== "function"
  ) {
    throw new TypeError("Missing admin admission guard");
  }
  return options.beforeLoad;
};

// Actual route declarations define the matrix, so new pages enter automatically.
const adminPaths = [
  ...new Set(
    readdirSync(import.meta.dirname, { recursive: true, encoding: "utf-8" })
      .filter(
        (file) =>
          file.endsWith(".tsx") &&
          !file.split(path.sep).some((part) => part.startsWith("-")),
      )
      .flatMap((file) => {
        const source = readFileSync(
          path.join(import.meta.dirname, file),
          "utf-8",
        );
        const declaration = /createFileRoute\(\s*"([^"]+)"/u.exec(source);
        const routePath = declaration?.at(1);
        return routePath === undefined
          ? []
          : [routePath.replace("/_protected", "").replace(/\/$/u, "")];
      }),
  ),
];
const CALLER = { userId: "admin-admission-user", organizationId: "org-a" };

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

describe("organization admin admission", () => {
  test("the admission matrix contains the root and every page", () => {
    expect(adminPaths).toContain("/admin");
    expect(adminPaths).toContain("/admin/members");
    expect(adminPaths).toContain("/admin/time-policy");
    expect(adminPaths.length).toBeGreaterThan(1);
  });

  for (const role of ORGANIZATION_ROLE_NAMES) {
    for (const pathname of adminPaths) {
      test(`${role} admission to ${pathname}`, async () => {
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        queryClient.setQueryData(roleOptions.queryKey, role);
        queryClient.setQueryData(workspacesNavigationOptions(CALLER).queryKey, {
          workspaces: [],
          features: { timeBilling: false },
        });
        const requestCount = requests.length;
        const outcome: unknown = await Promise.resolve()
          .then(() =>
            readAdmission()({
              context: {
                queryClient,
                user: {
                  id: CALLER.userId,
                  activeOrganizationId: CALLER.organizationId,
                },
              },
              location: { pathname },
              matches: [{ staticData: {} }],
            }),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        if (role === "owner" || role === "admin") {
          expect(outcome).toBeNull();
        } else {
          expect(isRedirect(outcome)).toBe(true);
          if (!isRedirect(outcome)) {
            throw new TypeError("Admin admission did not redirect", {
              cause: outcome,
            });
          }
          expect(outcome.options.to).toBe("/settings/account/profile");
          expect(outcome.options.replace).toBe(true);
        }
        expect(requests.slice(requestCount)).toEqual([]);
        queryClient.clear();
      });
    }
  }
});
