import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";

import en from "@/i18n/langs/en.json";
import { searchSchema } from "@/routes/law/cases/-case-law-search-schema";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { TopBarCountry } = await import("./top-bar-country");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

for (const { country, destination, label, court } of [
  {
    country: "cze",
    destination: "svk",
    label: "Slovakia",
    court: "Ústavní soud",
  },
  {
    country: "svk",
    destination: "cze",
    label: "Czechia",
    court: "Ústavný súd SR",
  },
]) {
  test(`switching ${country} to ${destination} passes facets to destination validation and resets pagination and rewrite context`, async () => {
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/law/cases/",
      validateSearch: searchSchema,
    });
    const parameters = new URLSearchParams({
      country,
      court,
      lang: "en",
      type: "judgment",
      sourceId: "00000000-0000-4000-8000-000000000001",
      from: "2026-01-01",
      to: "2026-12-31",
      q: "contract",
      page: "2",
      rewrite: "off",
      rewrittenFrom: "agreement",
      filterNotice: JSON.stringify([
        { field: "court", value: "old court", countries: [] },
      ]),
    });
    const router = createRouter({
      isServer: false,
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({
        initialEntries: [`/law/cases?${parameters}`],
      }),
    });
    await router.load();
    render(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <TooltipProvider delay={0}>
            <RouterContextProvider router={router}>
              <TopBarCountry />
            </RouterContextProvider>
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>,
    );
    expect(router.state.location.search.court).toBe(court);
    expect(router.state.location.search.page).toBe(2);
    expect(router.state.location.search.filterNotice).toEqual([
      {
        field: "court",
        value: "old court",
        countries: [],
      },
    ]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: en.common.country })),
    );
    const option = await screen.findByRole("menuitemradio", { name: label });
    await act(async () => fireEvent.click(option));
    await waitFor(() =>
      expect(router.state.location.search.country).toBe(destination),
    );
    expect(router.state.location.search).toMatchObject({
      court,
      lang: "en",
      type: "judgment",
      sourceId: "00000000-0000-4000-8000-000000000001",
      from: "2026-01-01",
      to: "2026-12-31",
      q: "contract",
    });
    expect(router.state.location.search.page).toBeUndefined();
    expect(router.state.location.search.filterNotice).toBeUndefined();
    expect(router.state.location.search.rewrite).toBeUndefined();
    expect(router.state.location.search.rewrittenFrom).toBeUndefined();
  });
}
