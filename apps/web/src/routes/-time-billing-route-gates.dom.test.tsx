import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { listTimeBillingRoutes } from "../../e2e/helpers/time-billing-routes";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
});

const originalFetch = globalThis.fetch;
// Auth imports may prime the session; billing reads must remain behind admission.
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
const { Result } = await import("better-result");
const { waitFor } = await import("@testing-library/dom");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");

const CALLER = { userId: "unenrolled-owner", organizationId: "org-a" };

const readRouteAdmission = async (filePath: string) => {
  const module: unknown = await import(filePath);
  if (typeof module !== "object" || module === null || !("Route" in module)) {
    throw new TypeError(`Missing route export: ${filePath}`);
  }
  const route = module.Route;
  if (typeof route !== "object" || route === null || !("options" in route)) {
    throw new TypeError(`Missing route options: ${filePath}`);
  }
  const options = route.options;
  if (
    typeof options !== "object" ||
    options === null ||
    !("beforeLoad" in options)
  ) {
    throw new TypeError(`Missing admission guard: ${filePath}`);
  }
  const beforeLoad = options.beforeLoad;
  if (typeof beforeLoad !== "function") {
    throw new TypeError(`Missing admission guard: ${filePath}`);
  }
  return {
    beforeLoad,
    staticData: "staticData" in options ? options.staticData : undefined,
  };
};

const redirectDestination = (routePath: string) => {
  if (routePath.startsWith("/_protected/workspaces/")) {
    return "/workspaces/$workspaceId";
  }
  if (routePath.startsWith("/_protected/settings/organization/")) {
    return "/settings/organization/members";
  }
  return "/workspaces";
};

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

describe("server enrollment admission across dedicated billing routes", () => {
  const routes = listTimeBillingRoutes();

  test("the source census contains guarded routes", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes.map(({ routePath }) => routePath)).size).toBe(
      routes.length,
    );
  });

  for (const { routePath, guardFilePath } of routes) {
    test(`${routePath} redirects an unenrolled owner before loading billing`, async () => {
      const { beforeLoad } = await readRouteAdmission(guardFilePath);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(workspacesNavigationOptions(CALLER).queryKey, {
        workspaces: [],
        features: { timeBilling: false },
      });
      queryClient.setQueryData(roleOptions.queryKey, "owner");
      const requestCount = requests.length;
      const params = { workspaceId: "matter-a", invoiceId: "invoice-a" };
      const outcome: unknown = await Promise.resolve()
        .then(() =>
          beforeLoad({
            context: {
              queryClient,
              user: {
                id: CALLER.userId,
                activeOrganizationId: CALLER.organizationId,
              },
            },
            params,
            location: { pathname: routePath.replace("/_protected", "") },
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isRedirect(outcome)).toBe(true);
      if (!isRedirect(outcome)) {
        throw new TypeError(`Admission did not redirect: ${routePath}`, {
          cause: outcome,
        });
      }
      expect(outcome.options.to).toBe(redirectDestination(routePath));
      if (routePath.startsWith("/_protected/workspaces/")) {
        expect(outcome.options.params).toMatchObject({
          workspaceId: params.workspaceId,
        });
      }
      expect(requests.slice(requestCount)).toEqual([]);
      queryClient.clear();
    });
  }
});

describe("organization settings admission request wave", () => {
  // Enumerate the real role-and-enrolment guards so a new sibling must opt in
  // to the same parallel admission contract.
  const routes = listTimeBillingRoutes().filter(({ guardFilePath }) =>
    readFileSync(guardFilePath, "utf-8").includes(
      "isBillingSettingsAccessible",
    ),
  );
  test("the census contains role-and-enrolment settings guards", () => {
    expect(routes.length).toBeGreaterThan(0);
  });
  for (const { routePath, guardFilePath } of routes) {
    test.each(["owner", "member"])(
      `${routePath} starts enrolment alongside the %s role check`,
      async (role) => {
        const { staticData } = await readRouteAdmission(guardFilePath);
        expect(staticData).toMatchObject({
          organizationSettingsAdmission: "time-billing",
        });
        const { beforeLoad } = await readRouteAdmission(
          "@/routes/_protected.settings/organization",
        );
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const roleResponse = Promise.withResolvers<Response>();
        const navigationResponse = Promise.withResolvers<Response>();
        const roleStarted = Promise.withResolvers<undefined>();
        const navigationStarted = Promise.withResolvers<undefined>();
        const paths: string[] = [];
        const fetch = spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: RequestInfo | URL) => {
              const pathname = new URL(
                input instanceof Request ? input.url : String(input),
              ).pathname;
              paths.push(pathname);
              if (
                pathname === "/api/auth/organization/get-active-member-role"
              ) {
                roleStarted.resolve(undefined);
                return await roleResponse.promise;
              }
              if (pathname === "/v1/workspaces/navigation") {
                navigationStarted.resolve(undefined);
                return await navigationResponse.promise;
              }
              return Response.json(null);
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        );
        const navigationOptions = workspacesNavigationOptions(CALLER);
        const admission = Result.tryPromise({
          try: async () =>
            await beforeLoad({
              context: {
                queryClient,
                user: {
                  id: CALLER.userId,
                  activeOrganizationId: CALLER.organizationId,
                },
              },
              location: { pathname: routePath.replace("/_protected", "") },
              matches: [{ staticData }],
            }),
          catch: (error) => error,
        });
        let admissionSettled = false;
        const observedAdmission = admission.then((outcome) => {
          admissionSettled = true;
          return outcome;
        });
        try {
          expect(
            queryClient.getQueryState(roleOptions.queryKey)?.fetchStatus,
          ).toBe("fetching");
          expect(
            queryClient.getQueryState(navigationOptions.queryKey)?.fetchStatus,
          ).toBe("fetching");
          await Promise.all([roleStarted.promise, navigationStarted.promise]);
          // Both transports have started while neither response has resolved.
          expect(
            queryClient.getQueryState(roleOptions.queryKey)?.fetchStatus,
          ).toBe("fetching");
          expect(
            queryClient.getQueryState(navigationOptions.queryKey)?.fetchStatus,
          ).toBe("fetching");
          if (role === "member") {
            roleResponse.resolve(Response.json({ role }));
            await waitFor(() => expect(admissionSettled).toBe(true));
            const outcome = await observedAdmission;
            expect(Result.isError(outcome)).toBe(true);
            const denial = Result.isError(outcome) ? outcome.error : undefined;
            expect(isRedirect(denial)).toBe(true);
            expect(denial).toMatchObject({
              options: { to: "/settings/account/profile" },
            });
            expect(
              queryClient.getQueryState(navigationOptions.queryKey)
                ?.fetchStatus,
            ).toBe("fetching");
          }
        } finally {
          roleResponse.resolve(Response.json({ role }));
          navigationResponse.resolve(
            Response.json({
              items: [],
              workspaces: [],
              features: { timeBilling: true },
              nextCursor: null,
            }),
          );
          const outcome = await admission;
          fetch.mockRestore();
          queryClient.clear();
          expect(Result.isOk(outcome)).toBe(role === "owner");
        }
        expect(
          paths.filter((pathname) => pathname === "/v1/workspaces/navigation"),
        ).toHaveLength(1);
      },
    );
  }
  test("unrelated organization settings leave navigation to deferred chrome", async () => {
    const { beforeLoad } = await readRouteAdmission(
      "@/routes/_protected.settings/organization",
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(roleOptions.queryKey, "owner");
    try {
      await beforeLoad({
        context: {
          queryClient,
          user: {
            id: CALLER.userId,
            activeOrganizationId: CALLER.organizationId,
          },
        },
        location: { pathname: "/settings/organization/members" },
        matches: [{ staticData: {} }],
      });
      expect(
        queryClient.getQueryState(workspacesNavigationOptions(CALLER).queryKey),
      ).toBeUndefined();
    } finally {
      queryClient.clear();
    }
  });
});
