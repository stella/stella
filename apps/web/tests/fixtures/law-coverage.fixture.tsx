import { createRoot } from "react-dom/client";

import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { IntlProvider } from "use-intl";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";

import { FormattingProvider } from "@/i18n/formatting-context";
import ar from "@/i18n/langs/ar.json" with { type: "json" };
import en from "@/i18n/langs/en.json" with { type: "json" };

import { CaseLawCoveragePage } from "@/routes/law/-law-coverage/coverage-page";
import { COVERAGE, CZECHIA, IN_PREPARATION } from "@/routes/law/-law-coverage/coverage-page.fixture";

const locale =
  new URL(location.href).searchParams.get("locale") === "ar" ? "ar" : "en";
document.documentElement.lang = locale;
document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
const rootRoute = createRootRoute();
const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/law/cases" }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/law/coverage",
      component: () => (
        <CaseLawCoveragePage
          coverage={{
            ...COVERAGE,
            countries: CASE_LAW_JURISDICTIONS.map((country) =>
              country === "CZE" ? CZECHIA : { ...IN_PREPARATION, country },
            ),
          }}
        />
      ),
    }),
  ]),
});

createRoot(document.body).render(
  <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <IntlProvider
      locale={locale}
      messages={locale === "ar" ? ar : en}
      timeZone="UTC"
    >
      <FormattingProvider locale={locale} timeZone="UTC">
        <RouterProvider router={router} />
      </FormattingProvider>
    </IntlProvider>
  </div>,
);
