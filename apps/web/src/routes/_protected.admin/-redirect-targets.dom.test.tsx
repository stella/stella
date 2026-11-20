import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const { organizationSettingsDestination } =
  await import("@/routes/-organization-settings-route");

afterAll(async () => {
  await unregisterDomEnvironment();
});

// Every legacy admin page, from the files that declare them.
const adminDirectory = import.meta.dirname;
const adminPages = readdirSync(adminDirectory)
  .filter(
    (file) =>
      file.endsWith(".tsx") && file !== "route.tsx" && !file.startsWith("-"),
  )
  .map((file) => path.basename(file, ".tsx"));

/** The page a route's component names as its redirect's target, if any. */
const redirectTargetOf = (routeModule: unknown): unknown => {
  if (
    typeof routeModule !== "object" ||
    routeModule === null ||
    !("Route" in routeModule)
  ) {
    throw new TypeError("Missing admin route export");
  }
  const route: unknown = routeModule.Route;
  if (typeof route !== "object" || route === null || !("options" in route)) {
    throw new TypeError("Missing admin route options");
  }
  const options: unknown = route.options;
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Missing admin route options");
  }
  const component: unknown = Reflect.get(options, "component");
  return typeof component === "function"
    ? Reflect.get(component, "redirectTarget")
    : undefined;
};

// The forms this layout's pending view leads to; the tables follow with
// their own pages.
const FORM_PAGES: readonly string[] = [
  "ai",
  "anonymization",
  "catalogue",
  "general",
  "index",
  "matter-numbering",
  "time-policy",
];

describe("legacy admin pages", () => {
  test("the matrix holds every form page", () => {
    for (const page of FORM_PAGES) {
      expect(adminPages).toContain(page);
    }
  });

  for (const page of adminPages) {
    test(`/admin/${page} names the page its layout redirects to`, async () => {
      const pathname = page === "index" ? "/admin/" : `/admin/${page}`;
      const target = redirectTargetOf(
        await import(path.join(adminDirectory, `${page}.tsx`)),
      );
      if (target === undefined) {
        // Only a page this wave has not reached may still name none.
        expect(FORM_PAGES).not.toContain(page);
        return;
      }
      expect(target).toBe(organizationSettingsDestination(pathname, {}).to);
    });
  }
});
