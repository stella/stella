import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  drainReactScheduler,
  unregisterDomEnvironment,
} from "@stll/property-testing/dom-environment";

import type { AppSnapshot, DesktopAccountSnapshot } from "../src/shared/rpc";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { clearMocks, mockIPC, mockWindows } =
  await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");
const { DesktopAppearanceProvider } =
  await import("../src/shared/use-desktop-appearance");
const { default: App } = await import("../src/mainview/App");
const { SETTINGS_PAGES } = await import("../src/mainview/settings-pages");

afterEach(async () => {
  await act(async () => {
    await drainReactScheduler();
  });
  cleanup();
  clearMocks();
  window.location.hash = "";
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const { pages } = defaultMessages.settings;

const APP_STATE = {
  documentRecovery: {
    edits: [],
    unassigned: false,
    pending: false,
    access: "available",
  },
  bridgePort: 45_901,
  bridgeVersion: 1,
  capabilities: [],
  notificationPreferences: {
    documentReady: true,
    revisionCreated: true,
    syncIssues: true,
  },
  runningSince: "2026-09-08T05:00:00.000Z",
  sessions: [],
  trustedSelfHostConnections: [],
  update: {
    currentVersion: "0.9.4",
  },
} satisfies AppSnapshot;

const ACCOUNT = {
  account: {
    email: "eliska.novakova@example.test",
    name: "Eliška Nováková",
    verifiedAt: "2026-10-27T07:30:00.000Z",
  },
  expiresAt: "2099-11-26T07:30:00.000Z",
  identity: { organizationId: "organization-1", userId: "user-1" },
  server: "https://app.example.test",
  status: "connected",
  avatar: null,
} satisfies DesktopAccountSnapshot;

type Native = {
  activity?: boolean;
  dictation?: boolean;
  /** "pending" never answers `get_state`, as before the snapshot arrives. */
  snapshot?: "ready" | "pending";
};

/** The native side of a linked account; features as `native` says. */
const renderApp = async ({
  activity = false,
  dictation = false,
  snapshot = "ready",
}: Native) => {
  const commands: string[] = [];
  mockWindows("main");
  mockIPC(
    async (command) => {
      commands.push(command);
      switch (command) {
        case "account_get_state":
          return ACCOUNT;
        case "get_state":
          return snapshot === "ready"
            ? APP_STATE
            : await Promise.withResolvers<never>().promise;
        case "updater_state":
          return { revision: 1, state: { status: "idle" } };
        case "check_for_updates":
          return { revision: 2, state: { status: "up_to_date" } };
        case "is_activity_enabled":
          return activity;
        case "dictation_get_snapshot":
          return { available: dictation };
        case "get_desktop_telemetry_enabled":
          return true;
        case "permissions_get_snapshot":
          return {
            rows: [
              { permission: "notifications", status: "granted" },
              { permission: "openAtLogin", status: "granted" },
              { permission: "accessibility", status: "denied" },
            ],
          };
        case "chatgpt_auth_get_status":
          return { state: "signed_out", sessionStored: false, accounts: [] };
        case "claude_code_auth_get_status":
          return { state: "not_installed" };
        case "harness_get_status":
          return [
            { harness: "codex", state: { state: "not_installed" } },
            { harness: "claude-code", state: { state: "not_installed" } },
          ];
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <DesktopAppearanceProvider
        value={{ adopt: () => undefined, appearance: "system" }}
      >
        <App />
      </DesktopAppearanceProvider>
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await drainReactScheduler();
  });
  const nav = view.getByRole("navigation", {
    name: defaultMessages.settings.title,
  });
  const entry = (name: string) => within(nav).getByRole("button", { name });
  return { ...view, commands, entry, nav };
};

const currentEntries = (nav: HTMLElement) =>
  [...nav.querySelectorAll("[aria-current]")].map((entry) => ({
    current: entry.getAttribute("aria-current"),
    name: entry.textContent,
  }));

test("the sidebar names every page in order and marks only the open one as current", async () => {
  const { entry, getByRole, nav } = await renderApp({
    activity: true,
    dictation: true,
  });

  const names = [...nav.querySelectorAll("button")].map(
    (button) => button.textContent,
  );
  // Signing is a macOS setting; this computer reads as another platform.
  expect(names).toEqual(
    SETTINGS_PAGES.filter((page) => page !== "signing").map(
      (page) => pages[page],
    ),
  );
  expect(currentEntries(nav)).toEqual([
    { current: "page", name: pages.general },
  ]);
  expect(getByRole("heading", { level: 1 }).textContent).toBe(pages.general);

  await act(async () => {
    fireEvent.click(entry(pages.permissions));
  });

  expect(currentEntries(nav)).toEqual([
    { current: "page", name: pages.permissions },
  ]);
  expect(getByRole("heading", { level: 1 }).textContent).toBe(
    pages.permissions,
  );
  expect(window.location.hash).toBe("#permissions");
});

test("every page is reachable from the keyboard", async () => {
  const { entry } = await renderApp({});

  for (const name of [pages.general, pages.about]) {
    const button = entry(name);
    expect(button.tagName).toBe("BUTTON");
    expect(button.tabIndex).toBe(0);
    expect(button.hasAttribute("disabled")).toBe(false);
  }
});

test("pages a feature decides are offered only with that feature", async () => {
  const { nav } = await renderApp({});

  const names = [...nav.querySelectorAll("button")].map(
    (button) => button.textContent,
  );
  expect(names).not.toContain(pages.activity);
  expect(names).not.toContain(pages.dictation);
  expect(names).toContain(pages.clipboard);
});

test("General holds the account as one row, the app settings and privacy", async () => {
  const { container, getByRole } = await renderApp({});
  const settingsPage =
    container.querySelector<HTMLElement>("[data-slot=settings-page]") ??
    document.body;

  const account = within(settingsPage)
    .getByText(ACCOUNT.account.name)
    .closest("li");
  expect(account?.textContent).toContain(ACCOUNT.account.email);
  expect(account?.textContent).toContain("app.example.test");
  expect(account?.textContent).toContain(
    defaultMessages.settings.accountLinked,
  );
  expect(
    within(account ?? document.body).getByRole("button", {
      name: defaultMessages.settings.disconnect,
    }),
  ).toBeTruthy();
  await waitFor(() => {
    expect(
      getByRole("switch", { name: defaultMessages.settings.startOnLogin }),
    ).toBeTruthy();
  });
  expect(
    getByRole("switch", { name: defaultMessages.settings.sendCrashReports }),
  ).toBeTruthy();
});

test("the native side opens a page by its id", async () => {
  const { getByRole, nav } = await renderApp({});

  await act(async () => {
    await emit("activate-tab", { tab: "about" });
  });

  expect(currentEntries(nav)).toEqual([{ current: "page", name: pages.about }]);
  expect(getByRole("heading", { level: 1 }).textContent).toBe(pages.about);
  expect(
    getByRole("heading", { level: 1 }).ownerDocument.body.textContent,
  ).toContain(APP_STATE.update.currentVersion);
});

test("the tray's update check opens About and answers there", async () => {
  const { commands, findByText, nav } = await renderApp({});

  await act(async () => {
    await emit("activate-tab", { tab: "about", focus: "update-check" });
  });

  expect(currentEntries(nav)).toEqual([{ current: "page", name: pages.about }]);
  expect(
    await findByText(defaultMessages.settings.updates.upToDate),
  ).toBeTruthy();
  expect(commands.filter((command) => command === "check_for_updates")).toEqual(
    ["check_for_updates"],
  );
});

test("a window opened for the update check runs it once", async () => {
  window.location.hash = "#about/update-check";
  const { commands, findByText, nav } = await renderApp({});

  expect(currentEntries(nav)).toEqual([{ current: "page", name: pages.about }]);
  expect(
    await findByText(defaultMessages.settings.updates.upToDate),
  ).toBeTruthy();
  expect(commands.filter((command) => command === "check_for_updates")).toEqual(
    ["check_for_updates"],
  );
  expect(window.location.hash).toBe("#about");
});

test("About never names a preview build while the version loads", async () => {
  const { entry, queryByText } = await renderApp({ snapshot: "pending" });

  fireEvent.click(entry(pages.about));
  await act(async () => {
    await drainReactScheduler();
  });

  expect(queryByText(defaultMessages.settings.previewBuild)).toBeNull();
  expect(queryByText(defaultMessages.settings.developmentBuild)).toBeNull();
});

test("a link to a coding agent opens AI and agents and brings its card into view", async () => {
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this.dataset["agentSettings"] ?? "");
  };
  try {
    const { findByText, nav } = await renderApp({});

    await act(async () => {
      await emit("activate-tab", { tab: "agents", focus: "claude-code" });
    });

    expect(currentEntries(nav)).toEqual([
      { current: "page", name: pages.agents },
    ]);
    const card = (
      await findByText(
        defaultMessages.agentSubscriptions.install.notInstalled.replace(
          "{name}",
          "Claude Code",
        ),
      )
    ).closest<HTMLElement>("[data-agent-settings]");
    await waitFor(() => {
      expect(document.activeElement).toBe(card);
    });
    expect(scrolled.filter(Boolean)).toEqual(["claude-code"]);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

test("a focus sent with any other page is ignored", async () => {
  const { nav } = await renderApp({});

  await act(async () => {
    await emit("activate-tab", { tab: "general", focus: "codex" });
  });
  await act(async () => {
    fireEvent.click(within(nav).getByRole("button", { name: pages.agents }));
  });

  await act(async () => {
    await drainReactScheduler();
  });
  expect(document.activeElement?.closest("[data-agent-settings]")).toBeNull();
});

test("an unknown page id keeps the open page", async () => {
  const { entry, nav } = await renderApp({});
  await act(async () => {
    fireEvent.click(entry(pages.about));
  });

  await act(async () => {
    await emit("activate-tab", { tab: "billing" });
  });

  expect(currentEntries(nav)).toEqual([{ current: "page", name: pages.about }]);
});

test("leaving AI and agents drops a link's focus before its card shows", async () => {
  const { entry, nav } = await renderApp({});
  await act(async () => {
    await emit("activate-tab", { tab: "agents", focus: "codex" });
  });
  await act(async () => {
    fireEvent.click(entry(pages.general));
  });

  await act(async () => {
    fireEvent.click(entry(pages.agents));
  });
  await act(async () => {
    await drainReactScheduler();
  });

  expect(currentEntries(nav)).toEqual([
    { current: "page", name: pages.agents },
  ]);
  expect(document.activeElement?.closest("[data-agent-settings]")).toBeNull();
});
