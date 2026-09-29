import { QueryClient } from "@tanstack/react-query";
import type { DataTag } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { sessionOptions } from "@/lib/auth-queries";
import {
  afterOnboardingNavigation,
  afterSignInNavigation,
  onboardingNavigation,
} from "@/lib/redirect";
import { Route as ProtectedRoute } from "@/routes/_protected";
import { Route as AuthRoute } from "@/routes/auth/index";
import { Route as OrganizationRoute } from "@/routes/auth/organization";
import { Route as OnboardingRoute } from "@/routes/onboarding/route";

/**
 * The trip through sign-in, driven through the app's own route definitions:
 * each step runs the real `validateSearch` and `beforeLoad` with a stubbed
 * session, and the component steps use the navigation the components use.
 */

const DESTINATION = "/knowledge/templates?intent=use&slug=nda";

type Account = { signedIn: boolean; organizationId: string | null };

type SessionData =
  typeof sessionOptions.queryKey extends DataTag<unknown, infer TData>
    ? TData
    : never;

const sessionFor = (account: Account) =>
  account.signedIn
    ? {
        session: {
          userId: "user_1",
          activeOrganizationId: account.organizationId,
        },
        user: { id: "user_1", email: "a@example.com", name: "A" },
      }
    : null;

/** A query client holding a fresh session read, so no request is made. */
const queryClientFor = (account: Account) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The stub carries only the fields the route guards read.
  queryClient.setQueryData(
    sessionOptions.queryKey,
    sessionFor(account) as unknown as SessionData,
  );
  return queryClient;
};

type RouteOptions = { beforeLoad?: unknown; validateSearch?: unknown };

/** Runs a route's real `beforeLoad` and returns the redirect it throws, if any. */
const runBeforeLoad = async (
  route: { options: RouteOptions },
  args: Record<string, unknown>,
) => {
  const beforeLoad = route.options.beforeLoad;
  if (typeof beforeLoad !== "function") {
    throw new TypeError("route has no beforeLoad");
  }
  const outcome = await Promise.resolve()
    .then(() => beforeLoad(args))
    .then(
      () => null,
      (error: unknown) => error,
    );
  if (outcome === null) {
    return null;
  }
  if (!isRedirect(outcome)) {
    throw outcome;
  }
  return outcome.options;
};

/** Parses a search object with a route's real search schema. */
const validateSearch = (
  route: { options: RouteOptions },
  search: Record<string, unknown>,
): Record<string, unknown> => {
  const schema = route.options.validateSearch;
  const parsed: unknown = v.parse(schema as unknown as v.GenericSchema, search);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("search schema returned a non-object");
  }
  return Object.fromEntries(Object.entries(parsed));
};

const location = (pathname: string, searchStr = "") => ({
  pathname,
  searchStr,
  hash: "",
});

const protectedRedirect = async (account: Account) =>
  await runBeforeLoad(ProtectedRoute, {
    context: { queryClient: queryClientFor(account) },
    location: location("/knowledge/templates", "?intent=use&slug=nda"),
  });

const organizationStep = async (
  account: Account,
  search: Record<string, unknown>,
) => {
  const parsed = validateSearch(OrganizationRoute, search);
  return {
    search: parsed,
    redirect: await runBeforeLoad(OrganizationRoute, {
      context: { session: sessionFor(account)?.session ?? null },
      location: location("/auth/organization"),
      search: parsed,
    }),
  };
};

const onboardingStep = async (
  account: Account,
  search: Record<string, unknown>,
) => {
  const parsed = validateSearch(OnboardingRoute, search);
  return {
    search: parsed,
    redirect: await runBeforeLoad(OnboardingRoute, {
      context: { queryClient: queryClientFor(account) },
      search: parsed,
    }),
  };
};

const redirectToOf = (search: unknown): string | undefined => {
  const value: unknown =
    typeof search === "object" && search !== null
      ? Reflect.get(search, "redirectTo")
      : undefined;
  return typeof value === "string" ? value : undefined;
};

describe("return path through sign-in, on the app's routes", () => {
  test("a new account comes back to the page it asked for, query included", async () => {
    const account: Account = { signedIn: false, organizationId: null };

    // The protected page sends the visitor to sign in with its path + query.
    const toAuth = await protectedRedirect(account);
    expect(toAuth).toMatchObject({
      to: "/auth",
      search: { redirectTo: DESTINATION },
    });
    const authSearch = validateSearch(AuthRoute, { redirectTo: DESTINATION });
    expect(authSearch).toEqual({ redirectTo: DESTINATION });

    // The code is accepted: on to the organization step, destination kept.
    account.signedIn = true;
    const afterSignIn = afterSignInNavigation(DESTINATION);
    expect(afterSignIn).toMatchObject({
      to: "/auth/organization",
      search: { redirectTo: DESTINATION },
    });

    // No organization yet: the step stays, then hands over to onboarding.
    const organization = await organizationStep(account, {
      redirectTo: DESTINATION,
    });
    expect(organization.redirect).toBeNull();
    const toOnboarding = onboardingNavigation(
      redirectToOf(organization.search),
    );
    expect(toOnboarding).toMatchObject({
      to: "/onboarding",
      search: { redirectTo: DESTINATION },
    });

    // Onboarding keeps it while the wizard runs and ends on it.
    const onboarding = await onboardingStep(account, {
      redirectTo: redirectToOf(toOnboarding.search),
    });
    expect(onboarding.redirect).toBeNull();
    expect(onboarding.search).toEqual({ redirectTo: DESTINATION });
    expect(
      afterOnboardingNavigation(redirectToOf(onboarding.search)),
    ).toMatchObject({ href: DESTINATION });

    // Reloading onboarding once the organization exists goes there as well.
    account.organizationId = "org_1";
    const reloaded = await onboardingStep(account, {
      redirectTo: DESTINATION,
    });
    expect(reloaded.redirect).toMatchObject({ href: DESTINATION });
  });

  test("a signed-in account without an organization keeps the page", async () => {
    const toOrganization = await protectedRedirect({
      signedIn: true,
      organizationId: null,
    });
    expect(toOrganization).toMatchObject({
      to: "/auth/organization",
      search: { redirectTo: DESTINATION },
    });
  });

  test("an existing account goes straight back to the page it asked for", async () => {
    const account: Account = { signedIn: true, organizationId: "org_1" };
    const organization = await organizationStep(account, {
      redirectTo: DESTINATION,
    });
    expect(organization.redirect).toMatchObject({ to: DESTINATION });
  });

  test("a signed-in visit to sign-in forwards the destination", async () => {
    const forwarded = await runBeforeLoad(AuthRoute, {
      context: {
        session: sessionFor({ signedIn: true, organizationId: null }),
      },
      location: location("/auth"),
      search: { redirectTo: DESTINATION },
    });
    expect(forwarded).toMatchObject({
      to: "/auth/organization",
      search: { redirectTo: DESTINATION },
    });
  });

  test("a signed-out visit to onboarding keeps the destination through sign-in", async () => {
    const onboarding = await onboardingStep(
      { signedIn: false, organizationId: null },
      { redirectTo: DESTINATION },
    );
    expect(onboarding.redirect).toMatchObject({
      to: "/auth",
      search: { redirectTo: DESTINATION },
    });
  });

  test("onboarding without a destination lands in chat", async () => {
    const onboarding = await onboardingStep(
      { signedIn: true, organizationId: null },
      {},
    );
    expect(onboarding.search).toEqual({});
    expect(afterOnboardingNavigation(undefined)).toMatchObject({
      href: "/chat",
    });
  });

  test("a hostile destination lands on the home page", async () => {
    const account: Account = { signedIn: true, organizationId: "org_1" };
    for (const evil of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "/x/..//evil.com",
    ]) {
      const organization = await organizationStep(account, {
        redirectTo: evil,
      });
      expect(organization.redirect).toMatchObject({ to: "/" });
    }
  });

  test("onboarding drops a destination that resolves into sign-in", async () => {
    for (const loop of ["/auth/otp", "/x/../auth", "/x/%2e%2e/onboarding"]) {
      const onboarding = await onboardingStep(
        { signedIn: true, organizationId: null },
        { redirectTo: loop },
      );
      expect(onboarding.search).toEqual({ redirectTo: undefined });
      expect(onboardingNavigation(loop)).toMatchObject({
        search: { redirectTo: undefined },
      });
    }
  });
});
