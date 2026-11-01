import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { settingsNavSections } from "@/routes/_protected.settings/-components/settings-shell/settings-nav";
import type { SettingsNavAccess } from "@/routes/_protected.settings/-components/settings-shell/settings-nav";

const ALL_OPEN = {
  role: "owner",
  memory: true,
  beta: true,
  timeBilling: true,
  usage: true,
} satisfies SettingsNavAccess;

const paths = (access: SettingsNavAccess) =>
  settingsNavSections(access).map(({ id, items }) => [
    id,
    items.map(({ to }) => to),
  ]);

describe("settingsNavSections", () => {
  test("managers see their account, then the organization", () => {
    expect(paths(ALL_OPEN)).toEqual([
      [
        "account",
        [
          "/settings/account/profile",
          "/settings/account/desktop",
          "/settings/account/connections",
          "/settings/account/memory",
          "/settings/account/beta",
        ],
      ],
      [
        "organization",
        [
          "/settings/organization/general",
          "/settings/organization/members",
          "/settings/organization/usage",
          "/settings/organization/audit-logs",
        ],
      ],
      [
        "ai",
        [
          "/settings/organization/ai",
          "/settings/organization/anonymization",
          "/settings/organization/tools",
        ],
      ],
      [
        "firm-setup",
        [
          "/settings/organization/matter-numbering",
          "/settings/organization/document-types",
          "/settings/organization/time-policy",
          "/settings/organization/number-series",
          "/settings/organization/vat-rates",
          "/settings/organization/billing",
        ],
      ],
    ]);
  });

  test.each(ORGANIZATION_ROLE_NAMES)(
    "organization sections follow management access: %s",
    (role) => {
      const ids = settingsNavSections({ ...ALL_OPEN, role }).map(
        ({ id }) => id,
      );
      expect(ids.includes("organization")).toBe(
        role === "owner" || role === "admin",
      );
      expect(ids).toContain("account");
    },
  );

  test("an unknown role shows only the account", () => {
    expect(
      settingsNavSections({ ...ALL_OPEN, role: undefined }).map(({ id }) => id),
    ).toEqual(["account"]);
  });

  test("closed gates hide only their own items", () => {
    const sections = settingsNavSections({
      role: "owner",
      memory: false,
      beta: false,
      timeBilling: false,
      usage: false,
    });
    const shown = sections.flatMap(({ items }) => items.map(({ to }) => to));
    for (const hidden of [
      "/settings/account/memory",
      "/settings/account/beta",
      "/settings/organization/time-policy",
      "/settings/organization/number-series",
      "/settings/organization/vat-rates",
      "/settings/organization/billing",
      "/settings/organization/usage",
    ]) {
      expect(shown).not.toContain(hidden);
    }
    expect(shown).toContain("/settings/organization/matter-numbering");
    expect(shown).toContain("/settings/account/profile");
  });
});
