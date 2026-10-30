import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRouter } from "@tanstack/react-router";
import { plugin } from "bun";
import { afterAll, expect, test } from "bun:test";

import { createAnalyticsValue } from "@/lib/analytics/provider";
import { createRouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { createAppQueryClient } from "@/lib/react-query";
import { WEB_ROUTE_TEMPLATES } from "@/route-templates.gen";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { declaredBreadcrumbs } from "./app-breadcrumbs.logic";

GlobalRegistrator.register({ url: "http://localhost:3000" });
afterAll(async () => await unregisterDomEnvironment());

plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

const { routeTree } = await import("@/routeTree.gen");
const analyticsValue = createAnalyticsValue(WEB_ROUTE_TEMPLATES);
const router = createRouter({
  routeTree,
  context: {
    analyticsValue,
    queryClient: createAppQueryClient(),
    routeErrorLifecycle: createRouteErrorLifecycleController(
      analyticsValue.analytics,
    ),
  },
});

const ORGANIZATION_SETTINGS_BREADCRUMBS = [
  { type: "label", labelKey: "common.settings", to: "/settings" },
  {
    type: "label",
    labelKey: "common.organization",
    to: "/settings/organization",
  },
] as const;

test.each([
  {
    pathname: "/contacts/contact-id",
    decisions: [
      { type: "label", labelKey: "navigation.contacts", to: "/contacts" },
      { type: "entity", entity: "contact" },
    ],
  },
  {
    pathname: "/contacts/import",
    decisions: [
      { type: "label", labelKey: "navigation.contacts", to: "/contacts" },
      {
        type: "label",
        labelKey: "contacts.importStudio.title",
        to: "/contacts/import",
      },
    ],
  },
  {
    pathname: "/workspaces/matter-id",
    decisions: [
      { type: "label", labelKey: "common.matters", to: "/workspaces" },
      { type: "entity", entity: "matter" },
    ],
  },
  {
    pathname: "/workspaces/matter-id/view-id/document",
    decisions: [
      { type: "label", labelKey: "common.matters", to: "/workspaces" },
      { type: "entity", entity: "matter" },
      { type: "entity", entity: "pdf" },
    ],
  },
  {
    pathname: "/knowledge/tools/entry",
    decisions: [
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
    ],
  },
  {
    pathname: "/settings/organization/members",
    decisions: [
      ...ORGANIZATION_SETTINGS_BREADCRUMBS,
      {
        type: "label",
        labelKey: "common.members",
        to: "/settings/organization/members",
      },
    ],
  },
])(
  "$pathname breadcrumbs follow its generated route matches",
  ({ pathname, decisions }) => {
    const matches = router.matchRoutes(pathname);

    expect(
      declaredBreadcrumbs(matches).map(({ decision }) => decision),
    ).toEqual([...decisions]);
  },
);
