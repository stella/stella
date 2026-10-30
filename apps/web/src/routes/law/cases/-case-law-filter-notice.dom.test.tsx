import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import cs from "@/i18n/langs/cs.json";
import en from "@/i18n/langs/en.json";
import { searchSchema } from "@/routes/law/cases/-case-law-search-schema";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { CaseLawFilterNotice } = await import("./-case-law-filter-notice");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

for (const { locale, messages, countryName, linkName } of [
  {
    locale: "en",
    messages: en,
    countryName: "Czechia",
    linkName: "Show Ústavný súd SR in Slovakia",
  },
  {
    locale: "cs",
    messages: cs,
    countryName: "Česko",
    linkName: "Zobrazit Ústavný súd SR pro zemi Slovensko",
  },
]) {
  test(`${locale} notice names the removed court and links to its country while retaining the date range`, async () => {
    const search = v.parse(searchSchema, {
      country: "cze",
      from: "2026-01-01",
      to: "2026-12-31",
      q: "contract",
      type: "judgment",
      page: 2,
      questions: ["question-fixture"],
      rewrite: "off",
      rewrittenFrom: "original contract",
      filterNotice: [
        { field: "court", value: "Ústavný súd SR", countries: ["SVK"] },
      ],
    });
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/law/cases/",
      validateSearch: searchSchema,
    });
    const router = createRouter({
      isServer: false,
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({
        initialEntries: ["/law/cases?country=cze"],
      }),
    });
    await router.load();
    await router.navigate({ to: "/law/cases", search });
    let dismissCount = 0;
    render(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <FormattingProvider locale={locale} timeZone="UTC">
          <TooltipProvider delay={0}>
            <RouterContextProvider router={router}>
              <CaseLawFilterNotice
                country="CZE"
                search={search}
                onDismiss={() => {
                  dismissCount += 1;
                }}
              />
            </RouterContextProvider>
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain("Ústavný súd SR");
    expect(screen.getByRole("status").textContent).toContain(countryName);
    const link = screen.getByRole("link", { name: linkName });
    const url = new URL(
      link.getAttribute("href") ?? "",
      "http://localhost:3000",
    );
    expect(url.searchParams.get("country")).toBe("svk");
    expect(url.searchParams.get("court")).toBe("Ústavný súd SR");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-12-31");
    expect(url.searchParams.get("q")).toBe("contract");
    expect(url.searchParams.get("type")).toBe("judgment");
    expect(url.searchParams.get("questions")).toBe(
      JSON.stringify(["question-fixture"]),
    );
    expect(url.searchParams.get("rewrite")).toBe("off");
    expect(url.searchParams.get("rewrittenFrom")).toBe("original contract");
    expect(url.searchParams.has("filterNotice")).toBe(false);
    expect(url.searchParams.has("page")).toBe(false);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.dismiss }),
      ),
    );
    expect(dismissCount).toBe(1);
  });
}
