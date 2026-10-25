import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { settingsNavSections } from "@/components/settings-shell/settings-nav";
import type { SettingsNavAccess } from "@/components/settings-shell/settings-nav";

const ALL_OPEN = {
  role: "owner",
  memory: true,
  beta: true,
  timeBilling: true,
} satisfies SettingsNavAccess;

const paths = (access: SettingsNavAccess) =>
  settingsNavSections(access).map(({ id, items }) => [
    id,
    items.map(({ link }) => link.to),
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
          "/admin/general",
          "/admin/members",
          "/admin/usage",
          "/admin/audit-logs",
        ],
      ],
      ["ai", ["/admin/ai", "/admin/anonymization", "/admin/tools"]],
      [
        "firm-setup",
        [
          "/admin/matter-numbering",
          "/admin/document-types",
          "/admin/time-policy",
          "/admin/number-series",
          "/admin/vat-rates",
          "/admin/billing",
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
    });
    const shown = sections.flatMap(({ items }) =>
      items.map(({ link }) => link.to),
    );
    for (const hidden of [
      "/settings/account/memory",
      "/settings/account/beta",
      "/admin/time-policy",
      "/admin/number-series",
      "/admin/vat-rates",
      "/admin/billing",
    ]) {
      expect(shown).not.toContain(hidden);
    }
    expect(shown).toContain("/admin/matter-numbering");
    expect(shown).toContain("/settings/account/profile");
  });
});
