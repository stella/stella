import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

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
const { roleOptions } = await import("@/lib/auth-queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");

const CALLER = { userId: "unenrolled-owner", organizationId: "org-a" };

const readBeforeLoad = async (filePath: string) => {
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
  return beforeLoad;
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
  await GlobalRegistrator.unregister();
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
      const beforeLoad = await readBeforeLoad(guardFilePath);
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

describe("billing settings admission request overlap", () => {
  const routes = listTimeBillingRoutes().filter(({ routePath }) =>
    [
      "/_protected/settings/organization/vat-rates",
      "/_protected/settings/organization/number-series",
      "/_protected/settings/organization/billing",
    ].includes(routePath),
  );

  for (const { routePath, guardFilePath } of routes) {
    for (const { failure } of [
      { failure: "none" },
      { failure: "role" },
      { failure: "preview" },
      { failure: "both" },
    ] as const) {
      test(`${routePath} starts both admission requests before either settles (${failure})`, async () => {
        const beforeLoad = await readBeforeLoad(guardFilePath);
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const roleStarted = Promise.withResolvers<undefined>();
        const previewStarted = Promise.withResolvers<undefined>();
        const roleResponse = Promise.withResolvers<Response>();
        const previewResponse = Promise.withResolvers<Response>();
        const previousFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL) => {
            const url = input instanceof Request ? input.url : String(input);
            switch (new URL(url).pathname) {
              case "/api/auth/organization/get-active-member-role":
                roleStarted.resolve(undefined);
                return await roleResponse.promise;
              case "/v1/workspaces/navigation":
                previewStarted.resolve(undefined);
                return await previewResponse.promise;
              default:
                return await previousFetch(input);
            }
          },
          { preconnect: () => undefined },
        );
        let settled = false;
        const outcome = Promise.resolve()
          .then(() =>
            beforeLoad({
              context: {
                queryClient,
                user: {
                  id: CALLER.userId,
                  activeOrganizationId: CALLER.organizationId,
                },
              },
            }),
          )
          .then(
            () => {
              settled = true;
              return null;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
        const launchDeadline = Promise.withResolvers<never>();
        const timeout = setTimeout(() => {
          launchDeadline.reject(
            new Error("Admission requests did not start together"),
          );
        }, 1000);
        try {
          await Promise.race([
            Promise.all([roleStarted.promise, previewStarted.promise]),
            launchDeadline.promise,
          ]);
          expect(settled).toBe(false);
          // Settle preview first, including its failure; role must still decide first.
          previewResponse.resolve(
            failure === "preview" || failure === "both"
              ? Response.json(
                  { message: "Preview admission failed" },
                  { status: 400 },
                )
              : Response.json({
                  items: [],
                  workspaces: [],
                  features: { timeBilling: true },
                  limit: 50,
                  nextCursor: null,
                }),
          );
          await queryClient
            .query({
              ...workspacesNavigationOptions(CALLER),
              staleTime: "static",
            })
            .then(
              () => undefined,
              () => undefined,
            );
          expect(settled).toBe(false);
          roleResponse.resolve(
            failure === "role" || failure === "both"
              ? Response.json(
                  { message: "Role admission failed" },
                  { status: 400 },
                )
              : Response.json({ role: "owner" }),
          );
          const result = await outcome;
          switch (failure) {
            case "none":
              expect(result).toBeNull();
              break;
            case "role":
            case "both":
              expect(result).toMatchObject({ status: 400 });
              expect(result).toBe(
                queryClient.getQueryState(roleOptions.queryKey)?.error,
              );
              break;
            case "preview":
              expect(result).toMatchObject({ status: 400 });
              expect(result).toBe(
                queryClient.getQueryState(
                  workspacesNavigationOptions(CALLER).queryKey,
                )?.error,
              );
              break;
            default:
              failure satisfies never;
          }
        } finally {
          clearTimeout(timeout);
          roleResponse.resolve(Response.json({ role: "owner" }));
          previewResponse.resolve(
            Response.json({
              items: [],
              workspaces: [],
              features: { timeBilling: true },
              limit: 50,
              nextCursor: null,
            }),
          );
          await outcome;
          queryClient.clear();
          globalThis.fetch = previousFetch;
        }
      });
    }
  }
});
