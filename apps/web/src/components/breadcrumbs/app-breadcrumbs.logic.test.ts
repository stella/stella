import { expect, test } from "bun:test";

import { routePresentation } from "@/lib/route-presentation";

import { declaredBreadcrumbs } from "./app-breadcrumbs.logic";

test("breadcrumbs follow route metadata, including the beta settings page", () => {
  const breadcrumbs = declaredBreadcrumbs([
    {
      routeId: "/settings",
      staticData: {
        presentation: routePresentation({
          type: "label",
          labelKey: "common.settings",
          to: "/settings",
        }),
      },
    },
    {
      routeId: "/settings/account/beta",
      staticData: {
        presentation: routePresentation({
          type: "label",
          labelKey: "settings.account.beta",
          to: "/settings/account/beta",
        }),
      },
    },
  ]);

  expect(breadcrumbs.map(({ decision }) => decision)).toEqual([
    { type: "label", labelKey: "common.settings", to: "/settings" },
    {
      type: "label",
      labelKey: "settings.account.beta",
      to: "/settings/account/beta",
    },
  ]);
});

test("explicit inherit and none decisions add no crumb", () => {
  expect(
    declaredBreadcrumbs([
      {
        routeId: "/inherited",
        staticData: { presentation: routePresentation({ type: "inherit" }) },
      },
      {
        routeId: "/none",
        staticData: { presentation: routePresentation({ type: "none" }) },
      },
    ]),
  ).toEqual([]);
});
