import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { parseTimeZoneId } from "@stll/time";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

import type { TimePolicySettings } from "./time-policy.logic";

beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const USER = {
  activeOrganizationId: "org-1",
  email: "member@example.test",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const SETTINGS = {
  timeMinimumUnitMinutes: 6,
  timeEditWindowDays: 7,
  timeLockedThroughMonth: "2020-01-31",
  timeNarrativeRequired: true,
  timeZone: parseTimeZoneId("Europe/Prague") ?? panic("Prague is unknown"),
} satisfies TimePolicySettings;

const catalogs = { en, ar };
const ROLES = ["owner", "admin", "member", "intern", "external"] as const;

type RenderPolicyOptions = {
  role: (typeof ROLES)[number];
  locale: keyof typeof catalogs;
};
const renderPolicy = async ({ role, locale }: RenderPolicyOptions) => {
  const { TimePolicyForm } = await import("./time-policy-card");
  const { authClient } = await import("@/lib/auth-client");
  const canEdit = authClient.organization.checkRolePermission({
    role,
    permissions: { organizationSettings: ["update"] },
  });
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={catalogs[locale]} timeZone="UTC">
        <AuthenticatedUserProvider user={USER}>
          <TimePolicyForm settings={SETTINGS} canEdit={canEdit} />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const controlTags = (markup: string) => {
  const controls = [
    /<[^>]+role="combobox"[^>]*>/u,
    /<input\b[^>]*type="number"[^>]*>/u,
    /<input\b[^>]*aria-label="Year"[^>]*>/u,
    /<[^>]+role="switch"[^>]*>/u,
  ].map((pattern) => markup.match(pattern)?.at(0));
  for (const control of controls) {
    expect(control).toBeDefined();
  }
  return controls;
};

describe("time policy editing permissions", () => {
  for (const role of ["member", "intern", "external"] as const) {
    test(`${role} can inspect policy but cannot edit or save it`, async () => {
      const markup = await renderPolicy({ role, locale: "en" });

      for (const control of controlTags(markup)) {
        expect(control).toContain('disabled=""');
      }
      expect(markup).not.toContain(en.common.saveChanges);
      expect(markup).toContain('value="7"');
      expect(markup).toContain('value="2020"');
    });
  }

  for (const role of ["owner", "admin"] as const) {
    test(`${role} can edit policy and sees the save action`, async () => {
      const markup = await renderPolicy({ role, locale: "en" });

      for (const control of controlTags(markup)) {
        expect(control).not.toContain('disabled=""');
      }
      expect(markup).toContain(en.common.saveChanges);
    });
  }

  test("policy labels and help text use the Arabic catalog", async () => {
    const markup = await renderPolicy({ role: "admin", locale: "ar" });

    for (const key of [
      "minimumUnit",
      "minimumUnitHelp",
      "editWindow",
      "editWindowHelp",
      "lockedThrough",
      "lockedThroughHelp",
      "narrativeRequired",
    ] as const) {
      expect(markup).toContain(ar.settings.organization.timePolicy[key]);
      expect(markup).not.toContain(en.settings.organization.timePolicy[key]);
    }
    expect(markup).toContain(ar.common.saveChanges);
  });
});
