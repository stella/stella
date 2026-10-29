import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { organizationSettingsDestination } from "@/routes/_protected.admin/-route-cutover";

const EMPTY_SEARCH = {};

test("the organization and legacy roots resolve to General", () => {
  for (const pathname of [
    "/settings/organization",
    "/settings/organization/",
    "/admin",
    "/admin/",
  ]) {
    expect(organizationSettingsDestination(pathname, EMPTY_SEARCH)).toEqual({
      to: "/settings/organization/general",
      search: EMPTY_SEARCH,
    });
  }
});

test("every legacy admin route preserves its section in Settings", () => {
  const sections = readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".tsx") && name !== "route.tsx")
    .map((name) => name.replace(/\.tsx$/u, ""))
    .filter((name) => name !== "index");
  expect(sections.length).toBeGreaterThan(0);
  for (const section of sections) {
    expect(
      organizationSettingsDestination(`/admin/${section}`, EMPTY_SEARCH),
    ).toEqual({
      to: `/settings/organization/${section}`,
      search: EMPTY_SEARCH,
    });
  }
});

test("legacy member search is forwarded with its matching section", () => {
  expect(
    organizationSettingsDestination("/admin/members", { q: "alice" }),
  ).toEqual({
    to: "/settings/organization/members",
    search: { q: "alice" },
  });
});
