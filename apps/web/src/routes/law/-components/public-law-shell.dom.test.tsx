import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type {
  decisionLawCrumbTrailOf,
  statuteLawCrumbTrailOf,
} from "../-law-crumb-trail.logic";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { PublicLawBreadcrumbs } = await import("./public-law-shell");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

const statute = {
  status: "current",
  versionValidFrom: "2026-01-01",
  expressionKind: "consolidation",
  windowDisposition: "effective",
  country: "CZE",
  eli: "/eli/cz/sb/2026/178",
  title: "178/2026 Sb., o portálu kritické infrastruktury",
} satisfies Parameters<typeof statuteLawCrumbTrailOf>[0];
const decision = {
  court: "Nejvyšší správní soud",
  courtAbbreviation: "NSS",
  courtTier: "supreme",
  caseNumber: "7 Azs 172/2025",
  decisionDate: "2026-01-10",
  metadata: { legalArea: "Správní právo" },
} satisfies Parameters<typeof decisionLawCrumbTrailOf>[0];

type MountOptions = {
  kind: "statute" | "versioned-statute" | "decision";
  locale?: string;
  document?: Parameters<typeof statuteLawCrumbTrailOf>[0];
};

const mount = async ({
  kind,
  locale = "en",
  document = statute,
}: MountOptions) => {
  const root = createRootRoute();
  const route =
    kind !== "decision"
      ? createRoute({
          getParentRoute: () => root,
          path:
            kind === "versioned-statute"
              ? "/law/$country/statutes/$slug/v/$version"
              : "/law/$country/statutes/$slug/",
          loader: () => ({ statute: document, work: statute }),
        })
      : createRoute({
          getParentRoute: () => root,
          path: "/law/$country/cases/$court/$slug",
          loader: () => decision,
        });
  const statuteUrl =
    kind === "versioned-statute"
      ? "/law/cze/statutes/178-2026-sb/v/2026-01-01"
      : "/law/cze/statutes/178-2026-sb";
  const router = createRouter({
    isServer: false,
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [
        kind !== "decision" ? statuteUrl : "/law/cze/cases/nss/7-azs-172-2025",
      ],
    }),
  });
  await router.load();
  return render(
    <IntlProvider
      locale={locale}
      messages={locale === "ar" ? ar : en}
      timeZone="UTC"
    >
      <FormattingProvider locale={locale} timeZone="UTC">
        <TooltipProvider delay={0}>
          <RouterContextProvider router={router}>
            <PublicLawBreadcrumbs />
          </RouterContextProvider>
        </TooltipProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
};

test("statute shell shows linked hierarchy, identity, short title and the full title tooltip", async () => {
  const { container } = await mount({ kind: "statute" });
  expect(
    screen
      .getByRole("link", { name: en.common.legalDatabase })
      .getAttribute("href"),
  ).toBe("/law");
  expect(
    screen.getByRole("link", { name: en.statutes.title }).getAttribute("href"),
  ).toBe("/law/cze/statutes");
  expect(screen.getByRole("link", { name: "2026" }).getAttribute("href")).toBe(
    "/law/cze/statutes?year=2026",
  );
  const page = container.querySelector('[aria-current="page"]');
  expect(page?.textContent).toContain("178/2026");
  expect(page?.textContent).toContain("o portálu kritické infrastruktury");
  expect(page?.querySelector('[data-kind="statute"]')).not.toBeNull();
  const trigger = page?.querySelector('[data-slot="tooltip-trigger"]');
  expect(trigger).toBeTruthy();
  if (trigger === null || trigger === undefined) {
    return;
  }
  await act(async () => fireEvent.mouseEnter(trigger));
  await waitFor(() =>
    expect(
      screen
        .getByText(statute.title)
        .closest('[data-slot="tooltip-popup"][data-open]')?.textContent,
    ).toBe(statute.title),
  );
});

test("decision shell links court and decision year before the current docket and legal area", async () => {
  const { container } = await mount({ kind: "decision" });
  expect(
    screen.getByRole("link", { name: en.common.caseLaw }).getAttribute("href"),
  ).toBe("/law/cases");
  const court = screen.getByRole("link", { name: /Nejvyšší správní soud/u });
  expect(
    new URL(
      court.getAttribute("href") ?? "",
      "http://localhost:3000",
    ).searchParams.get("court"),
  ).toBe(decision.court);
  expect(court.querySelector('[data-kind="decision"]')).not.toBeNull();
  const yearUrl = new URL(
    screen.getByRole("link", { name: "2026" }).getAttribute("href") ?? "",
    "http://localhost:3000",
  );
  expect(yearUrl.pathname).toBe("/law/cases");
  expect(yearUrl.searchParams.get("court")).toBe(decision.court);
  expect(yearUrl.searchParams.get("year")).toBe("2026");
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
    decision.caseNumber,
  );
  expect(screen.getByText(/Správní právo/u)).toBeTruthy();
});

test("Arabic chrome keeps statute identity isolated and the publisher title intact", async () => {
  const { container } = await mount({ kind: "statute", locale: "ar" });
  expect(
    screen.getByRole("link", { name: ar.statutes.title }).getAttribute("href"),
  ).toBe("/law/cze/statutes");
  expect(
    container.querySelector('[data-kind="statute"]')?.getAttribute("dir"),
  ).toBe("ltr");
  expect(
    screen.getByText("o portálu kritické infrastruktury").getAttribute("dir"),
  ).toBe("auto");
});

test.each([{ kind: "statute" }, { kind: "versioned-statute" }] as const)(
  "$kind breadcrumb retains the accessible status alongside its identity",
  async ({ kind }) => {
    await mount({ kind });
    const status = screen.getByRole("img", {
      name: en.statutes.status.current,
    });
    expect(status.closest('[aria-current="page"]')).not.toBeNull();
    expect(
      status
        .querySelector('[data-slot="review-status-dot"]')
        ?.classList.contains("bg-success"),
    ).toBe(true);
  },
);

test("versioned statute breadcrumb names an expression that never entered into force", async () => {
  await mount({
    kind: "versioned-statute",
    document: { ...statute, windowDisposition: "never-in-force" },
  });
  const status = screen.getByRole("img", {
    name: en.statutes.status.neverInForce,
  });
  expect(
    status
      .querySelector('[data-slot="review-status-dot"]')
      ?.classList.contains("bg-muted-foreground"),
  ).toBe(true);
  expect(
    screen.queryByRole("img", { name: en.statutes.status.current }),
  ).toBeNull();
});
