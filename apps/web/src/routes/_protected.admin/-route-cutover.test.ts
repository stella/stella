import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { legacyAdminSettingsDestination } from "@/routes/_protected.admin/-route-cutover";

test("every legacy admin route preserves its section in Settings", () => {
  expect(legacyAdminSettingsDestination("/admin")).toBe(
    "/settings/organization/general",
  );
  const sections = readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".tsx") && name !== "route.tsx")
    .map((name) => name.replace(/\.tsx$/u, ""))
    .filter((name) => name !== "index");
  expect(sections.length).toBeGreaterThan(0);
  for (const section of sections) {
    expect(legacyAdminSettingsDestination(`/admin/${section}`)).toBe(
      `/settings/organization/${section}`,
    );
  }
});
