import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { organizationCreateOutputSchema } from "@stll/api-contract/organization-create";

import { PRESENTATION_PREFS_COOKIE } from "../../src/lib/account/presentation-prefs/preferences";
import {
  getOauthHashFragment,
  oauthConsentInfoSchema,
} from "../../src/lib/oauth-provider";
import { E2E_API_ORIGIN } from "../helpers/api";
import { pushRouterPath } from "../helpers/decision-reader";
import { contractJson, respond } from "../helpers/route-mock";
import { signInWithEmailOtp } from "../helpers/sign-in";
import { waitForStableGeometry } from "../helpers/stable-geometry";
import { expect, test } from "../helpers/test";

const clientName = "Geometry app";
const organizationName = "Geometry firm";
const commonScopes = "openid profile stella:read stella:search";
const consentHrefFor = (scope: string) => {
  const query = new URLSearchParams({
    client_id: "geometry-app",
    redirect_uri: "https://example.test/callback",
    scope,
    sig: "geometry-fixture",
  });
  return `/consent#${getOauthHashFragment(query.toString())}`;
};
const consentBody = '[data-slot="consent-card"]';
const decisionBar = '[data-slot="consent-decision-bar"]';
const onboarding = '[data-slot="onboarding-layout"]';

const consent = {
  path: "/consent",
  href: consentHrefFor(commonScopes),
  variant: "common permissions",
  landmarks: [consentBody, `${consentBody} h1`, decisionBar],
  loaded: '[data-slot="unverified-client-mark"]',
  waitOn: "/api/auth/oauth2/consent-info",
} as const;

const onboardingFlow = {
  path: "/onboarding",
  href: "/onboarding",
  variant: "first step",
  landmarks: [
    `${onboarding} h1`,
    `${onboarding} :is([data-slot="input-face"], [data-slot="input-control"])`,
    `${onboarding} div:has(> :is(button[type="submit"], [data-slot="button-face"]))`,
  ],
  loaded: `${onboarding} button[type="submit"]`,
  waitOn: "/v1/catalogue/native-tool-deploy-availability",
} as const;

const phone = { width: 390, height: 844 } as const;
const desktop = { width: 1440, height: 900 } as const;

const cases = [
  { ...consent, viewport: phone },
  { ...consent, viewport: desktop },
  {
    ...consent,
    href: consentHrefFor(`${commonScopes} offline_access`),
    variant: "with offline access",
    viewport: desktop,
  },
  { ...onboardingFlow, viewport: phone },
  { ...onboardingFlow, viewport: desktop },
] as const;

type Landmark = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type ConsentDesktopGeometryException = {
  route: "/consent";
  viewport: typeof desktop;
  axis: "vertical";
  maxEdgeShiftPx: number;
  maxCenterShiftPx: number;
  reason: `${string} ${string}`;
};

const consentDesktopGeometryException = {
  route: "/consent",
  viewport: desktop,
  axis: "vertical",
  maxEdgeShiftPx: 24,
  maxCenterShiftPx: 0.5,
  reason:
    "The signed OAuth fragment is unavailable to the server, and verification, permission summaries and account details can change the height of the centered consent card.",
} as const satisfies ConsentDesktopGeometryException;

type GeometryCase = (typeof cases)[number];

const geometryExceptionFor = ({
  path,
  viewport,
}: {
  path: GeometryCase["path"];
  viewport: { width: number; height: number };
}) =>
  path === consentDesktopGeometryException.route &&
  viewport.width === consentDesktopGeometryException.viewport.width &&
  viewport.height === consentDesktopGeometryException.viewport.height
    ? consentDesktopGeometryException
    : null;

const axes = {
  vertical: { bounded: ["top", "bottom"], exact: ["left", "right"] },
} as const;

const measureDelivery = ({
  flow,
  pending,
  loaded,
}: {
  flow: GeometryCase;
  pending: readonly Landmark[];
  loaded: readonly Landmark[];
}) => {
  const exception = geometryExceptionFor(flow);
  if (exception === null) {
    expect(loaded).toEqual(pending);
    return;
  }
  const [pendingCard, pendingTitle, pendingBar] = pending;
  const [loadedCard, loadedTitle, loadedBar] = loaded;
  if (
    !pendingCard ||
    !pendingTitle ||
    !pendingBar ||
    !loadedCard ||
    !loadedTitle ||
    !loadedBar
  ) {
    throw new TypeError(
      "Desktop consent requires its card, title and decision bar",
    );
  }
  for (const [from, to] of [
    [pendingCard, loadedCard],
    [pendingTitle, loadedTitle],
    [pendingBar, loadedBar],
  ] as const) {
    const { exact, bounded } = axes[exception.axis];
    for (const edge of exact) {
      expect(to[edge]).toBe(from[edge]);
    }
    for (const edge of bounded) {
      expect(Math.abs(to[edge] - from[edge])).toBeLessThanOrEqual(
        exception.maxEdgeShiftPx,
      );
    }
  }
  const center = ({ top, bottom }: Landmark) => (top + bottom) / 2;
  expect(Math.abs(center(loadedCard) - center(pendingCard))).toBeLessThan(
    exception.maxCenterShiftPx,
  );
  expect(loadedTitle.top - loadedCard.top).toBe(
    pendingTitle.top - pendingCard.top,
  );
  expect(loadedTitle.bottom - loadedTitle.top).toBe(
    pendingTitle.bottom - pendingTitle.top,
  );
  expect(loadedBar.bottom - loadedBar.top).toBe(
    pendingBar.bottom - pendingBar.top,
  );
  expect(loadedCard.bottom - loadedBar.bottom).toBe(
    pendingCard.bottom - pendingBar.bottom,
  );
};

const activateConsentOrganization = async (
  api: APIRequestContext,
  slug: string,
) => {
  const created = await api.post(`${E2E_API_ORIGIN}/v1/organizations`, {
    data: { name: organizationName, slug },
    headers: {
      "Idempotency-Key": slug,
      [CAPABILITY_REQUEST_HEADER]: "organizations.create",
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { organizationId } = v.parse(
    organizationCreateOutputSchema,
    await created.json(),
  );
  const activated = await api.post(
    `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
    { data: { organizationId } },
  );
  expect(activated.ok(), await activated.text()).toBe(true);
  const jurisdiction = await api.post(
    `${E2E_API_ORIGIN}/v1/organization-settings/practice-jurisdictions`,
    {
      data: { practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }] },
    },
  );
  expect(jurisdiction.ok(), await jurisdiction.text()).toBe(true);
};

const readLandmarks = async (page: Page, selectors: readonly string[]) => {
  const landmarks = selectors.map((selector) =>
    page.locator(selector).filter({ visible: true }).first(),
  );
  await waitForStableGeometry(page, landmarks);
  return await Promise.all(
    landmarks.map(
      async (landmark) =>
        await landmark.evaluate((node) => {
          const { left, top, right, bottom } = node.getBoundingClientRect();
          return { left, top, right, bottom };
        }),
    ),
  );
};

const presentationCookie = (url: string, locale: "en" | "cs") => ({
  name: PRESENTATION_PREFS_COOKIE,
  value: encodeURIComponent(JSON.stringify({ visitorLocale: locale })),
  url,
});

const loadConsentFixture = async (page: Page, release: Promise<undefined>) => {
  await page.route(
    (url) => url.pathname === "/api/auth/oauth2/consent-info",
    async (route) => {
      await release;
      await respond(
        route,
        contractJson(oauthConsentInfoSchema, {
          client: { type: "unverified", name: clientName },
          redirectTargets: ["https://example.test/callback"],
          clientIdHost: null,
        }),
      );
    },
  );
};

for (const locale of ["en", "cs"] as const) {
  for (const flow of cases) {
    test.describe(`${flow.path} (${flow.variant}) at ${flow.viewport.width}px in ${locale}`, () => {
      test.use({
        viewport: flow.viewport,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      test("preserves its loading landmarks", async ({
        baseURL,
        browser,
        browserErrors,
        page,
        playwright,
      }, testInfo) => {
        if (baseURL === undefined) {
          throw new TypeError("Account geometry requires a web base URL");
        }
        const api = await playwright.request.newContext({
          extraHTTPHeaders: { origin: new URL(baseURL).origin },
        });
        try {
          // Isolate the account's locale and keep onboarding on its first step.
          const account = `geometry-${randomUUID()}`;
          await signInWithEmailOtp(api, `${account}@stella.dev`);
          const profile = await api.post(
            `${E2E_API_ORIGIN}/api/auth/update-user`,
            {
              data: { locale },
            },
          );
          expect(profile.ok(), await profile.text()).toBe(true);
          if (flow.path === "/consent") {
            await activateConsentOrganization(api, account);
          }
          await page.context().clearCookies();
          await page
            .context()
            .addCookies([
              ...(await api.storageState()).cookies,
              presentationCookie(baseURL, locale),
            ]);
        } finally {
          await api.dispose();
        }
        const cold = await browser.newPage({
          baseURL,
          javaScriptEnabled: false,
          locale,
          viewport: flow.viewport,
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
        });
        await cold.context().addCookies([presentationCookie(baseURL, locale)]);
        const client = await page.context().newPage();
        const stopTrackingClient = browserErrors.trackPage(client);
        const session = Promise.withResolvers<undefined>();
        const initialData = Promise.withResolvers<undefined>();
        const navigationData = Promise.withResolvers<undefined>();
        try {
          await cold.goto(flow.href);
          await expect(cold.locator("html")).toHaveAttribute("lang", locale);
          const server = await readLandmarks(cold, flow.landmarks);
          await page.route(
            (url) => url.pathname === "/api/auth/get-session",
            async (route) => {
              await session.promise;
              await route.continue();
            },
          );
          if (flow.path === "/consent") {
            await loadConsentFixture(page, initialData.promise);
          }
          const sessionRequested = page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname === "/api/auth/get-session",
          );
          await page.goto(flow.href, { waitUntil: "commit" });
          await sessionRequested;
          const pending = await readLandmarks(page, flow.landmarks);
          session.resolve(undefined);
          initialData.resolve(undefined);
          await expect(
            page.locator(flow.loaded).filter({ visible: true }),
          ).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          if (flow.path === "/consent") {
            await expect(
              page.getByText(organizationName, { exact: true }),
            ).toBeVisible();
          }
          const loaded = await readLandmarks(page, flow.landmarks);

          if (flow.path === "/consent") {
            await loadConsentFixture(client, navigationData.promise);
          } else {
            await client.route(
              (url) => url.pathname === flow.waitOn,
              async (route) => {
                await navigationData.promise;
                await route.continue();
              },
            );
          }
          await client.goto("/auth/error", { waitUntil: "domcontentloaded" });
          await expect(
            client.locator('[data-slot="frame-panel"] button'),
          ).toBeVisible();
          const navigationRequest = client.waitForRequest(
            (request) => new URL(request.url()).pathname === flow.waitOn,
          );
          await pushRouterPath(client, flow.href);
          await navigationRequest;
          if (flow.path === "/consent") {
            await expect(
              client.getByText(organizationName, { exact: true }),
            ).toBeVisible();
          }
          const navigationPending = await readLandmarks(client, flow.landmarks);
          navigationData.resolve(undefined);
          await expect(
            client.locator(flow.loaded).filter({ visible: true }),
          ).toBeVisible();
          await expect(client.locator("html")).toHaveAttribute("lang", locale);
          const navigationLoaded = await readLandmarks(client, flow.landmarks);

          await testInfo.attach("geometry.json", {
            contentType: "application/json",
            body: JSON.stringify({
              path: flow.path,
              exception: geometryExceptionFor(flow),
              locale,
              viewport: flow.viewport,
              variant: flow.variant,
              server,
              pending,
              loaded,
              navigationPending,
              navigationLoaded,
            }),
          });
          expect(pending).toEqual(server);
          measureDelivery({ flow, pending: server, loaded });
          expect(navigationPending).toEqual(navigationLoaded);
          expect(navigationLoaded).toEqual(loaded);
          if (flow.variant === "common permissions") {
            expect(loaded).toEqual(server);
          } else if (flow.variant === "with offline access") {
            expect(loaded).not.toEqual(server);
          }
          browserErrors.assertEmpty(flow.path);
        } finally {
          session.resolve(undefined);
          initialData.resolve(undefined);
          navigationData.resolve(undefined);
          stopTrackingClient();
          await client.close();
          await cold.close();
        }
      });
    });
  }
}
