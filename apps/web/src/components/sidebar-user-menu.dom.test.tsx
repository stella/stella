import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { settingsNavSections } from "@/components/settings-shell/settings-nav";
import type { Role } from "@/lib/auth-client";

const source = readFileSync(
  new URL("sidebar-user-menu.tsx", import.meta.url),
  "utf-8",
);

const accessFor = (role: Role) => ({
  role,
  memory: true,
  beta: true,
  timeBilling: true,
  usage: true,
});

const expectOneSettingsDestination = (role: Role) => {
  expect(role).toBeDefined();
  expect(source.match(/navigate\(\{\s*to: "\/settings"/gu)).toHaveLength(1);
  expect(source).not.toContain('t("admin.title")');
};

test("the member user menu renders exactly one Settings destination", () => {
  expectOneSettingsDestination("member");
});

test("the admin user menu renders exactly one Settings destination", () => {
  expectOneSettingsDestination("admin");
});

test("the owner user menu renders exactly one Settings destination", () => {
  expectOneSettingsDestination("owner");
});

test("organization settings are visible to admins", () => {
  expect(settingsNavSections(accessFor("admin")).map(({ id }) => id)).toContain(
    "organization",
  );
});

test("organization settings are visible to owners", () => {
  expect(settingsNavSections(accessFor("owner")).map(({ id }) => id)).toContain(
    "organization",
  );
});

test("organization settings are hidden from members", () => {
  expect(settingsNavSections(accessFor("member")).map(({ id }) => id)).toEqual([
    "account",
  ]);
});
