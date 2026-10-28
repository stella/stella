import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/eu/cases" });

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DecisionLanguageMenu, rowMatchedLanguage } =
  await import("./decision-cells");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const version = (language: string, id: string) => ({
  caseNumber: "T-33/03",
  country: "EU",
  court: "General Court",
  decisionDate: "2004-01-01",
  id,
  language,
  slug: `t-33-03-${language}`,
});

const ALTERNATES = [
  version("cs", "00000000-0000-4000-8000-000000000001"),
  version("de", "00000000-0000-4000-8000-000000000002"),
  version("en", "00000000-0000-4000-8000-000000000003"),
];

const renderMenu = async () => {
  const rootRoute = router.createRootRoute({
    component: () => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <DecisionLanguageMenu
            alternates={ALTERNATES}
            displayLanguage="en"
            searchQuery="planet-49"
          />
        </FormattingProvider>
      </IntlProvider>
    ),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/law/eu/cases"] }),
    isServer: false,
    routeTree: rootRoute,
  });
  await appRouter.load();
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>,
  );
};

test("the languages menu names every version and links each to its own route", async () => {
  const view = await renderMenu();
  const trigger = await waitFor(() =>
    view.getByRole("button", { name: "Language" }),
  );
  expect(trigger.textContent).toContain("3 languages");

  fireEvent.click(trigger);

  const items = await waitFor(() => {
    const found = view.getAllByRole("menuitem");
    expect(found).toHaveLength(ALTERNATES.length);
    return found;
  });
  // The label is the item's whole content: a link element that carries its
  // own empty children would draw a row of blank items here.
  expect(items.map((item) => item.textContent)).toEqual([
    "Czech",
    "German",
    "English",
  ]);
  expect(items.map((item) => item.getAttribute("href"))).toEqual([
    "/law/eu/cases/general-court/cs/t-33-03-cs",
    "/law/eu/cases/general-court/de/t-33-03-de",
    "/law/eu/cases/general-court/en/t-33-03-en",
  ]);
});

test("a row names the version that matched only when a text query matched it", () => {
  // A browse listing or a filter alone matched no words: its row is the
  // version chosen for the reader, and there is no match to name.
  expect(rowMatchedLanguage({ language: "bg" }, undefined)).toBeNull();
  expect(rowMatchedLanguage({ language: "bg" }, "  ")).toBeNull();
  expect(rowMatchedLanguage({ language: "BG" }, "planet-49")).toBe("bg");
});
