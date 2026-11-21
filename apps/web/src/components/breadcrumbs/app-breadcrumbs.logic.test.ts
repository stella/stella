import { expect, test } from "bun:test";

import { routePresentation } from "@/routes/-route-presentation";

import {
  declaredBreadcrumbs,
  trailEndsAtMatter,
} from "./app-breadcrumbs.logic";

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

test("detail routes can restore the crumb for an escaped layout", () => {
  const breadcrumbs = declaredBreadcrumbs([
    {
      routeId: "/knowledge",
      staticData: {
        presentation: routePresentation({
          type: "label",
          labelKey: "navigation.knowledge",
          to: "/knowledge",
        }),
      },
    },
    {
      routeId: "/knowledge/tools_/$entry",
      staticData: {
        presentation: routePresentation(
          { type: "knowledge-detail", detail: "skill" },
          {
            type: "label",
            labelKey: "knowledge.sections.tools.title",
            to: "/knowledge/tools",
          },
        ),
      },
    },
  ]);

  expect(breadcrumbs.map(({ decision }) => decision)).toEqual([
    {
      type: "label",
      labelKey: "navigation.knowledge",
      to: "/knowledge",
    },
    {
      type: "label",
      labelKey: "knowledge.sections.tools.title",
      to: "/knowledge/tools",
    },
    { type: "knowledge-detail", detail: "skill" },
  ]);
});

const matterMatch = {
  routeId: "/_protected/workspaces/$workspaceId",
  staticData: {
    presentation: routePresentation({ type: "entity", entity: "matter" }),
  },
};

test("the header stands for the matter on its own pages, not under a document", () => {
  const matterIndex = {
    routeId: "/_protected/workspaces/$workspaceId/",
    staticData: { presentation: routePresentation({ type: "inherit" }) },
  };
  const document = {
    routeId: "/_protected/workspaces/$workspaceId/$viewId/document",
    staticData: {
      presentation: routePresentation({ type: "entity", entity: "pdf" }),
    },
  };

  expect(trailEndsAtMatter([matterMatch, matterIndex])).toBe(true);
  expect(trailEndsAtMatter([matterMatch, document])).toBe(false);
  expect(trailEndsAtMatter([])).toBe(false);
});
