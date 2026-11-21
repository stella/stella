import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/account/profile",
  width: 1280,
});

const testing = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { PendingTextIntlScope } = await import("@/components/pending-text");
const {
  ACCOUNT_SECTION,
  ORGANIZATION_SECTIONS,
  SettingsChromeScope,
  SettingsPagePending,
} =
  await import("@/routes/_protected.settings/-components/settings-shell/settings-shell.pending");
const { ProfilePending } =
  await import("@/routes/_protected.settings/-account.profile.pending");
const { ConnectionsPending } =
  await import("@/routes/_protected.settings/-account.connections.pending");
const { MemoryPending } =
  await import("@/routes/_protected.settings/-account.memory.pending");
const { DesktopPending } =
  await import("@/routes/_protected.settings/-account.desktop.pending");
const { BetaPending } =
  await import("@/routes/_protected.settings/-account.beta.pending");
const { AIConfigPending } =
  await import("@/routes/_protected.settings/-organization.ai.pending");
const { AnonymizationPending } =
  await import("@/routes/_protected.settings/-organization.anonymization.pending");
const { OrganizationGeneralPending } =
  await import("@/routes/_protected.settings/-organization.general.pending");
const { MatterNumberingPending } =
  await import("@/routes/_protected.settings/-organization.matter-numbering.pending");
const { TimePolicyPending } =
  await import("@/routes/_protected.settings/-organization.time-policy.pending");
const { QueryClient } = await import("@tanstack/react-query");
const { PendingCacheScope } = await import("@/components/pending-cache");
const { organizationSettingsKeys } =
  await import("@/queries/organization-settings");
const { rootKeys } = await import("@/lib/account/auth-query-keys.logic");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const withIntl = (node: ReactNode) => (
  <IntlProvider locale="en" messages={messages}>
    <PendingTextIntlScope formattingLocale="en">{node}</PendingTextIntlScope>
  </IntlProvider>
);

const navRowCount = (container: HTMLElement) =>
  container.querySelectorAll(".bg-muted\\/30 svg").length;

const UNGATED_ACCOUNT_ROWS = ACCOUNT_SECTION.items.filter(
  (item) => !("gate" in item),
).length;

const UNGATED_ORGANIZATION_ROWS = ORGANIZATION_SECTIONS.flatMap(({ items }) =>
  items.filter((item) => !("gate" in item)),
).length;

describe("a settings page's pending view", () => {
  test("drawn before the shell mounts, it brings the settings chrome around the page", () => {
    const view = testing.render(
      <SettingsPagePending area="account">
        <p data-testid="page" />
      </SettingsPagePending>,
    );
    expect(view.getByTestId("page").closest("section") !== null).toBe(true);
    // The account rows every member sees, plus the shortcuts row.
    expect(navRowCount(view.container)).toBe(UNGATED_ACCOUNT_ROWS + 1);
    // Painted before intl: no label text, only its bars.
    expect(view.container.textContent).toBe("");
  });

  test("an organization page's chrome adds the organization's sections", () => {
    const view = testing.render(
      withIntl(
        <SettingsPagePending area="organization">
          <p data-testid="page" />
        </SettingsPagePending>,
      ),
    );
    // The account rows and the shortcuts row, then every organization row
    // its managers see whatever the organization's features.
    expect(UNGATED_ORGANIZATION_ROWS > 0).toBe(true);
    expect(navRowCount(view.container)).toBe(
      UNGATED_ACCOUNT_ROWS + 1 + UNGATED_ORGANIZATION_ROWS,
    );
    const captions = [
      ...view.container.querySelectorAll(".bg-muted\\/30 .uppercase"),
    ].map((caption) => caption.textContent);
    expect(captions).toEqual([
      messages.settings.account.title,
      messages.common.organization,
      messages.admin.ai,
      messages.admin.firmSetup,
    ]);
  });

  test("inside the live shell, it is the page alone", () => {
    const view = testing.render(
      <SettingsChromeScope>
        <SettingsPagePending area="account">
          <p data-testid="page" />
        </SettingsPagePending>
      </SettingsChromeScope>,
    );
    expect(view.getByTestId("page").parentElement === view.container).toBe(
      true,
    );
    expect(navRowCount(view.container)).toBe(0);
  });
});

describe("the account pages' pending views", () => {
  const views = {
    beta: BetaPending,
    connections: ConnectionsPending,
    desktop: DesktopPending,
    memory: MemoryPending,
    profile: ProfilePending,
  } as const;

  for (const [name, View] of Object.entries(views)) {
    test(`${name}: the real heading, and no loading line where content belongs`, () => {
      const view = testing.render(
        withIntl(
          <SettingsChromeScope>
            <View />
          </SettingsChromeScope>,
        ),
      );
      const heading = view.getByRole("heading", { level: 1 });
      expect(heading.textContent.length > 0).toBe(true);
      expect(view.container.textContent.includes(messages.common.loading)).toBe(
        false,
      );
    });
  }

  test("profile: the sections' titles in the page's order, chat as rows", () => {
    const view = testing.render(
      withIntl(
        <SettingsChromeScope>
          <ProfilePending />
        </SettingsChromeScope>,
      ),
    );
    const titles = [
      ...view.container.querySelectorAll('[data-slot="list-group-title"]'),
    ].map((title) => title.textContent);
    expect(titles).toEqual([
      messages.common.displayName,
      messages.settings.account.timezone,
      messages.navigation.chat,
      messages.settings.account.signInMethods.title,
      messages.settings.account.twoFactor.title,
      messages.common.sessions,
      messages.settings.account.personalDataExportTitle,
      messages.settings.account.dangerZone,
    ]);
    const chat = view.getByRole("region", { name: messages.navigation.chat });
    const chatRows = [
      ...chat.querySelectorAll('[data-slot="settings-row-title"]'),
    ].map((title) => title.textContent);
    expect(chatRows).toEqual([
      messages.settings.account.chatNotifications,
      messages.settings.account.chatTechnicalDetails,
    ]);
  });
});

describe("the organization forms' pending views", () => {
  const views = {
    ai: AIConfigPending,
    anonymization: AnonymizationPending,
    general: OrganizationGeneralPending,
    "matter numbering": MatterNumberingPending,
    "time policy": TimePolicyPending,
  } as const;

  for (const [name, View] of Object.entries(views)) {
    test(`${name}: the real heading, and no loading line where content belongs`, () => {
      const view = testing.render(
        withIntl(
          <SettingsChromeScope>
            <View />
          </SettingsChromeScope>,
        ),
      );
      const heading = view.getByRole("heading", { level: 1 });
      expect(heading.textContent.length > 0).toBe(true);
      expect(view.container.textContent.includes(messages.common.loading)).toBe(
        false,
      );
      // Inside the live shell: the page alone, no second navigation.
      expect(navRowCount(view.container)).toBe(0);
    });

    test(`${name}: drawn before intl, the organization's chrome and no text`, () => {
      const view = testing.render(<View />);
      expect(navRowCount(view.container)).toBe(
        UNGATED_ACCOUNT_ROWS + 1 + UNGATED_ORGANIZATION_ROWS,
      );
      expect(view.container.textContent).toBe("");
    });
  }
});

describe("the AI page's pending view and the organization's features", () => {
  const verificationTitle =
    messages.settings.organization.verificationDecisionModel.title;
  const memoryTitle = messages.settings.organization.memoryExtraction.title;

  const renderWithCache = (featureIds: readonly string[] | null) => {
    const client = new QueryClient();
    client.setQueryData(rootKeys.session, {
      user: { id: "user-a" },
      session: { activeOrganizationId: "org-a" },
    });
    if (featureIds !== null) {
      client.setQueryData(
        organizationSettingsKeys.byCaller({
          organizationId: "org-a",
          userId: "user-a",
        }),
        {
          declaredFeatureIds: [...featureIds],
          capabilities: Object.fromEntries(
            featureIds.map((id) => [id, { status: "enabled" }]),
          ),
          deploymentFeatures: {},
        },
      );
    }
    return testing.render(
      withIntl(
        <PendingCacheScope client={client}>
          <SettingsChromeScope>
            <AIConfigPending />
          </SettingsChromeScope>
        </PendingCacheScope>,
      ),
    );
  };

  test("draws the cards of the features the cached settings admit", () => {
    const view = renderWithCache([
      "list-verification",
      "legal-lists",
      "ai-memory",
    ]);
    expect(view.container.textContent.includes(verificationTitle)).toBe(true);
    expect(view.container.textContent.includes(memoryTitle)).toBe(true);
  });

  test("leaves them out with nothing cached", () => {
    const view = renderWithCache(null);
    expect(view.container.textContent.includes(verificationTitle)).toBe(false);
    expect(view.container.textContent.includes(memoryTitle)).toBe(false);
  });
});
