import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  normalizeRedirectTo,
  returnPathOf,
  toAppRedirectTo,
} from "@/lib/redirect";
import { onboardingSearchSchema } from "@/routes/onboarding/-search";

type Account = { signedIn: boolean; hasOrganization: boolean };

const DESTINATION = "/knowledge/templates?intent=use&slug=nda";

const redirectSearchSchema = v.object({
  redirectTo: v.optional(v.pipe(v.string(), v.transform(normalizeRedirectTo))),
});

/**
 * The trip through sign-in on a real router: each stand-in route makes the
 * same decision as its app route, with the same helpers and search schemas.
 * `/auth/organization` redirects where the app renders `<Navigate>`.
 */
const buildRouter = (account: Account, initialEntry: string) => {
  const rootRoute = createRootRoute();
  const protectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_protected",
    beforeLoad: ({ location }) => {
      const redirectTo = returnPathOf(location);
      if (!account.signedIn) {
        throw redirect({ to: "/auth", search: { redirectTo } });
      }
      if (!account.hasOrganization) {
        throw redirect({
          to: "/auth/organization",
          search: { redirectTo },
          replace: true,
        });
      }
    },
  });
  const organizationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/auth/organization",
    validateSearch: redirectSearchSchema,
    beforeLoad: ({ search }) => {
      if (account.hasOrganization) {
        throw redirect({ href: search.redirectTo ?? "/", replace: true });
      }
      throw redirect({
        to: "/onboarding",
        search: { redirectTo: toAppRedirectTo(search.redirectTo) },
        replace: true,
      });
    },
  });

  return createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    // A client router, so redirects navigate; tests have no window origin.
    isServer: false,
    origin: "https://app.test",
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/auth",
        validateSearch: redirectSearchSchema,
      }),
      organizationRoute,
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/onboarding",
        validateSearch: onboardingSearchSchema,
      }),
      protectedRoute.addChildren([
        createRoute({
          getParentRoute: () => protectedRoute,
          path: "/chat",
        }),
        createRoute({
          getParentRoute: () => protectedRoute,
          path: "/knowledge/templates",
        }),
      ]),
    ]),
  });
};

type TestRouter = ReturnType<typeof buildRouter>;

const at = (router: TestRouter) => ({
  pathname: router.state.location.pathname,
  search: router.state.location.search,
});

const redirectToIn = (router: TestRouter): string => {
  const value: unknown = Reflect.get(
    router.state.location.search,
    "redirectTo",
  );
  if (typeof value !== "string") {
    throw new TypeError("expected a redirectTo search param");
  }
  return value;
};

// What the OTP step and the sign-in dialog do once the code is accepted.
const verifyCode = async (router: TestRouter, account: Account) => {
  account.signedIn = true;
  await router.navigate({
    to: "/auth/organization",
    search: { redirectTo: redirectToIn(router) },
    replace: true,
  });
};

describe("return path through sign-in", () => {
  test("a new account comes back to the page it asked for, query included", async () => {
    const account = { signedIn: false, hasOrganization: false };
    const router = buildRouter(account, DESTINATION);
    await router.load();

    expect(at(router)).toEqual({
      pathname: "/auth",
      search: { redirectTo: DESTINATION },
    });

    await verifyCode(router, account);
    expect(at(router)).toEqual({
      pathname: "/onboarding",
      search: { redirectTo: DESTINATION },
    });

    // The wizard creates the organization and ends at its destination.
    account.hasOrganization = true;
    await router.navigate({ href: redirectToIn(router), replace: true });
    expect(at(router)).toEqual({
      pathname: "/knowledge/templates",
      search: { intent: "use", slug: "nda" },
    });
  });

  test("a signed-in account without an organization keeps the page through onboarding", async () => {
    const account = { signedIn: true, hasOrganization: false };
    const router = buildRouter(account, DESTINATION);
    await router.load();

    expect(at(router)).toEqual({
      pathname: "/onboarding",
      search: { redirectTo: DESTINATION },
    });
  });

  test("an existing account goes straight back to the page it asked for", async () => {
    const account = { signedIn: false, hasOrganization: true };
    const router = buildRouter(account, DESTINATION);
    await router.load();

    await verifyCode(router, account);
    expect(at(router)).toEqual({
      pathname: "/knowledge/templates",
      search: { intent: "use", slug: "nda" },
    });
  });

  test("a hostile destination lands on the home page", async () => {
    const account = { signedIn: true, hasOrganization: true };
    for (const evil of ["//evil.com", "/\\evil.com", "https://evil.com"]) {
      const router = buildRouter(
        account,
        `/auth/organization?redirectTo=${encodeURIComponent(evil)}`,
      );
      await router.load();
      expect(router.state.location.pathname).toBe("/");
    }
  });

  test("onboarding drops a destination that points back into sign-in", async () => {
    const account = { signedIn: true, hasOrganization: false };
    const router = buildRouter(
      account,
      `/auth/organization?redirectTo=${encodeURIComponent("/auth/otp")}`,
    );
    await router.load();

    expect(at(router)).toEqual({ pathname: "/onboarding", search: {} });
  });
});
