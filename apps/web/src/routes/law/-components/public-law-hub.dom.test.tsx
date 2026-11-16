import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cze" });

const { cleanup, render, waitFor } = await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { CaseLawBrowseLink, CaseLawBrowsePager, PublicLawHubLayout } =
  await import("./public-law-hub");

const COURT_LABEL = "court";
const YEAR_LABEL = "year";
const DAY_LABEL = "day";

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

/** The hub's links as a crawler reads them: every `<a href>` in the page. */
const renderHrefs = async (children: React.ReactNode) => {
  const rootRoute = router.createRootRoute({
    component: () => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PublicLawHubLayout description="d" title="t">
          {children}
        </PublicLawHubLayout>
      </IntlProvider>
    ),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/law/cze"] }),
    isServer: false,
    routeTree: rootRoute,
  });
  await appRouter.load();
  const view = render(<router.RouterProvider router={appRouter} />);
  await waitFor(() => view.getByRole("heading", { level: 1 }));
  return [...view.container.querySelectorAll("a")].map((anchor) =>
    anchor.getAttribute("href"),
  );
};

describe("public law hub links", () => {
  test("each browse level is a plain link to its canonical, query-free path", async () => {
    const hrefs = await renderHrefs(
      <>
        <CaseLawBrowseLink
          countryParam="cze"
          target={{ level: "court", court: "nejvyssi-soud" }}
        >
          {COURT_LABEL}
        </CaseLawBrowseLink>
        <CaseLawBrowseLink
          countryParam="cze"
          target={{ level: "year", court: "nejvyssi-soud", year: 2023 }}
        >
          {YEAR_LABEL}
        </CaseLawBrowseLink>
        <CaseLawBrowseLink
          countryParam="cze"
          target={{
            level: "day",
            court: "nejvyssi-soud",
            year: 2023,
            month: 5,
            day: 7,
            page: 1,
          }}
        >
          {DAY_LABEL}
        </CaseLawBrowseLink>
      </>,
    );
    expect(hrefs).toEqual([
      "/law/cze/courts/nejvyssi-soud",
      "/law/cze/courts/nejvyssi-soud/2023",
      "/law/cze/courts/nejvyssi-soud/2023/05/07",
    ]);
  });

  test("the pager links every earlier page and the next one", async () => {
    const hrefs = await renderHrefs(
      <CaseLawBrowsePager
        countryParam="cze"
        hasNext
        target={{
          level: "month",
          court: "nejvyssi-soud",
          year: 2023,
          month: 5,
          page: 3,
        }}
      />,
    );
    expect(hrefs).toEqual([
      "/law/cze/courts/nejvyssi-soud/2023/05",
      "/law/cze/courts/nejvyssi-soud/2023/05/page/2",
      "/law/cze/courts/nejvyssi-soud/2023/05/page/4",
    ]);
  });

  test("a single page has no pager", async () => {
    const hrefs = await renderHrefs(
      <CaseLawBrowsePager
        countryParam="cze"
        hasNext={false}
        target={{
          level: "day",
          court: "nejvyssi-soud",
          year: 2023,
          month: 5,
          day: 7,
          page: 1,
        }}
      />,
    );
    expect(hrefs).toEqual([]);
  });
});
