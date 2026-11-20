import { expect } from "@playwright/test";
import type { Browser } from "@playwright/test";
import * as v from "valibot";

import cs from "../../src/i18n/langs/cs.json" with { type: "json" };
import en from "../../src/i18n/langs/en.json" with { type: "json" };
import { apiDelete, apiPost, apiPut, E2E_API_ORIGIN } from "./api";
import { setPresentationPrefs } from "./presentation-prefs";
import { captureLandmarks } from "./stable-geometry";
import { createBrowserErrorCollector } from "./test";

const VIEWPORT = { width: 1440, height: 900 };
const LANGUAGES = [
  { locale: "en", browserLocale: "en-US", messages: en },
  { locale: "cs", browserLocale: "cs-CZ", messages: cs },
] as const;
type CommonSurface = {
  path: string;
  busy: string;
  landmarks: Readonly<Record<string, string>>;
};

type LoadingSurface = CommonSurface &
  (
    | { type: "steady" }
    | {
        type: "date";
        apiPath: string;
        nextLabel: (messages: typeof en | typeof cs) => string;
      }
    | {
        type: "filter";
        apiPath: string;
        filter: (messages: typeof en | typeof cs) => string;
      }
  );

const SURFACES = [
  {
    type: "date",
    path: "/time?date=2026-11-04",
    apiPath: "/v1/time-entries/me",
    busy: "main section:has(#my-week-day-title) ul[aria-busy=true]",
    nextLabel: (messages: typeof en | typeof cs) =>
      messages.timesheets.week.nextWeek,
    landmarks: {
      heading: "h1",
      header: "header:has(h1)",
      week: "nav:has(ol.grid-cols-7)",
      day: "#my-week-day-title",
    },
  },
  {
    type: "date",
    path: "/time/report?period=week&from=2026-11-02&to=2026-11-08",
    apiPath: "/v1/time-entries/report",
    busy: "main section[aria-busy=true]:has(table)",
    nextLabel: (messages: typeof en | typeof cs) => messages.common.next,
    landmarks: {
      heading: "h1",
      controls: "h1 + div",
      summary: "h1 + div + div",
      table: "table",
      firstRow: "tbody tr",
    },
  },
  {
    type: "steady",
    path: "/settings/organization/members",
    busy: "table:first-of-type tbody[aria-busy=true]",
    landmarks: {
      heading: "h1",
      section: "h2",
      table: "table",
      firstRow: "tbody tr",
    },
  },
  {
    type: "filter",
    path: "/settings/organization/audit-logs",
    apiPath: "/v1/audit-logs",
    busy: "tbody[aria-busy=true]",
    filter: (messages) =>
      messages.settings.organization.auditLogsResourceTypePlaceholder,
    landmarks: {
      heading: "h1",
      filters: "[data-slot=frame-panel] .grid.items-end",
      table: "table",
      firstRow: "tbody tr",
    },
  },
] as const satisfies readonly LoadingSurface[];

/**
 * The inbox and contact surfaces, recorded as evidence beside the others: the
 * contacts list, one contact (a fixture the measurement creates) and the
 * inbox, whose body the cold paint leaves to the layout this browser keeps.
 */
const contactSurfaces = (contactId: string): readonly LoadingSurface[] => [
  {
    type: "steady",
    path: "/contacts",
    busy: "tbody tr[aria-hidden=true]",
    landmarks: {
      heading: "thead",
      table: "table",
      firstRow: "tbody tr",
    },
  },
  {
    type: "steady",
    path: `/contacts/${contactId}`,
    busy: "h1 [data-slot=face-label-skeleton]",
    landmarks: {
      heading: "h1",
      firstSection: "section",
      secondSection: "section ~ section",
    },
  },
  {
    type: "steady",
    path: "/inbox",
    busy: "[data-slot=entity-view-kanban-pending], [data-slot=entity-view-table-pending]",
    landmarks: {
      heading: "fieldset",
      body: "[data-kanban-column-header], [data-slot=workspace-grid-head]",
    },
  },
];

/**
 * An organization skill's page, recorded as evidence beside the others: the
 * editor's identity block, how the skill runs and its files, on a skill the
 * measurement creates.
 */
const skillSurfaces = (skillId: string): readonly LoadingSurface[] => [
  {
    type: "steady",
    path: `/knowledge/tools/skills/${skillId}`,
    busy: "[data-slot=file-tree-row-pending]",
    landmarks: {
      heading: "[data-slot=skill-editor-identity]",
      runs: "[data-slot=skill-editor-identity] .grid",
      files: "[data-slot=skill-editor-files]",
    },
  },
];

type MeasureLoadingGeometryOptions = {
  browser: Browser;
  baseURL: string;
  storageState: string;
  /** Which surfaces to measure: time and admin, inbox and contacts, or a
   *  Knowledge skill's page. */
  set?: "time-admin" | "contacts" | "knowledge-skill" | undefined;
};

export const measureLoadingGeometry = async ({
  browser,
  baseURL,
  storageState,
  set = "time-admin",
}: MeasureLoadingGeometryOptions) => {
  const account = await browser.newContext({ baseURL, storageState });
  try {
    const session = await account.request.get(
      `${E2E_API_ORIGIN}/api/auth/get-session`,
    );
    await expect(session).toBeOK();
    const original = v.parse(
      v.object({ user: v.object({ locale: v.nullish(v.string(), null) }) }),
      await session.json(),
    );
    const setLocale = async (locale: string | null) => {
      const response = await account.request.post(
        `${E2E_API_ORIGIN}/api/auth/update-user`,
        {
          data: { locale },
          headers: { Origin: baseURL },
        },
      );
      await expect(response).toBeOK();
    };

    const contact =
      set === "contacts"
        ? v.parse(
            v.object({ id: v.string() }),
            await apiPut(account.request, "/contacts", {
              type: "organization",
              displayName: "Geometry fixture s.r.o.",
              organizationName: "Geometry fixture s.r.o.",
            }),
          )
        : null;
    const skill =
      set === "knowledge-skill"
        ? v.parse(
            v.object({ id: v.string() }),
            await apiPost(account.request, "/skills", {
              scope: "private",
              name: "Geometry fixture skill",
              description: "Geometry fixture",
              body: "Fixture instructions.",
            }),
          )
        : null;
    // The fixture's own surfaces, where the set made one.
    const fixtureSurfaces = (): readonly LoadingSurface[] | null => {
      if (contact !== null) {
        return contactSurfaces(contact.id);
      }
      if (skill !== null) {
        return skillSurfaces(skill.id);
      }
      return null;
    };
    const surfaces = fixtureSurfaces() ?? SURFACES;
    const evidence = [];
    try {
      for (const { locale, browserLocale, messages } of LANGUAGES) {
        await setLocale(locale);
        const options = {
          baseURL,
          storageState: await account.storageState(),
          locale: browserLocale,
          viewport: VIEWPORT,
        };
        const cold = await browser.newContext({
          ...options,
          javaScriptEnabled: false,
        });
        const live = await browser.newContext(options);
        try {
          await Promise.all(
            [cold, live].map(
              async (context) =>
                await setPresentationPrefs({
                  context,
                  url: baseURL,
                  patch: { sidebarOpen: true, visitorLocale: locale },
                }),
            ),
          );
          const serverPage = await cold.newPage();
          const page = await live.newPage();
          const errors = createBrowserErrorCollector();
          const detach = errors.trackPage(page);
          try {
            for (const surface of surfaces) {
              await serverPage.goto(surface.path);
              // Protected routes render a shared cold shell before locale hydration.
              const serverDocumentLanguage = await serverPage
                .locator("html")
                .getAttribute("lang");
              await expect(
                serverPage.locator(surface.landmarks.heading),
              ).toBeVisible();
              const server = await captureLandmarks(
                serverPage,
                surface.landmarks,
              );
              await page.goto(surface.path);
              await expect(page.locator("html")).toHaveAttribute(
                "lang",
                locale,
              );
              const busy = page.locator(surface.busy);
              await expect(busy).toHaveCount(0);
              const rowSelector =
                "firstRow" in surface.landmarks
                  ? surface.landmarks.firstRow
                  : surface.landmarks.heading;
              await expect(page.locator(rowSelector).first()).toBeVisible();
              await expect(busy).toHaveCount(0);
              const loaded = await captureLandmarks(page, surface.landmarks);

              if (surface.type === "steady") {
                evidence.push({
                  locale,
                  route: surface.path,
                  serverDocumentLanguage,
                  server,
                  loaded,
                });
                continue;
              }
              const next =
                surface.type === "date"
                  ? page.getByRole("button", {
                      name: surface.nextLabel(messages),
                      exact: true,
                    })
                  : page.getByPlaceholder(surface.filter(messages));
              await expect(next).toBeEnabled();
              const isDataRequest = (url: URL) =>
                url.pathname === surface.apiPath;
              const gate = Promise.withResolvers<undefined>();
              await page.route(isDataRequest, async (route) => {
                await gate.promise;
                await route.continue();
              });
              try {
                if (surface.type === "date") {
                  await next.click();
                } else {
                  await next.fill("workspace");
                }
                await expect(busy).toBeVisible();
                await expect(next).toBeEnabled();
                const pending = await captureLandmarks(page, surface.landmarks);
                gate.resolve(undefined);
                await expect(busy).toHaveCount(0);
                const stepped = await captureLandmarks(page, surface.landmarks);
                evidence.push({
                  locale,
                  route: surface.path,
                  serverDocumentLanguage,
                  server,
                  loaded,
                  pending,
                  stepped,
                });
              } finally {
                gate.resolve(undefined);
                await page.unroute(isDataRequest);
              }
            }
            errors.assertEmpty(
              `unexpected browser errors with ${locale} loading views`,
            );
          } finally {
            detach();
          }
        } finally {
          await Promise.all([cold.close(), live.close()]);
        }
      }
      return { viewport: VIEWPORT, evidence };
    } finally {
      await setLocale(original.user.locale);
      if (contact !== null) {
        await apiDelete(account.request, `/contacts/${contact.id}`);
      }
      if (skill !== null) {
        await apiDelete(account.request, `/skills/${skill.id}`);
      }
    }
  } finally {
    await account.close();
  }
};
