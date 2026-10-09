import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type {
  DesktopRegistryConfig,
  DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";

import type { ClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import arMessages from "../../src/i18n/langs/ar.json" with { type: "json" };
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };
import type { AppSnapshot, DesktopAccountSnapshot } from "../../src/shared/rpc";

const REGISTRIES = [
  {
    id: "ares",
    name: "Czech commercial registry",
    formatType: "company-specification",
  },
  {
    id: "companies-house",
    name: "Companies House",
    formatType: "company-specification",
  },
] as const satisfies DesktopRegistryConfig["registries"];
// A company specification carries emphasis markers: the card renders them and
// the copy keeps both the rich and the stripped representation.
const RESULT_TEXT = "Registry result for ACME PLC";
const RESULT_RENDERED = "Registry result for **ACME PLC**";
const RESULT_HTML = "Registry result for <strong>ACME PLC</strong>";
const FORMATTED_TEXT = "Saved detailed registry output for ACME PLC";
const FORMATTED_RENDERED = "Saved detailed registry output for **ACME PLC**";
const FORMATTED_HTML =
  "Saved detailed registry output for <strong>ACME PLC</strong>";
const SEARCH_RESPONSE = {
  defaultFormatId: "11111111-1111-4111-8111-111111111111",
  // The firm's default until the member pins one of their own.
  defaultFormatSource: "organization",
  formats: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Saved compact" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Saved detailed" },
  ],
  results: [
    {
      id: "company-1",
      name: "Stella Example s.r.o.",
      rendered: RESULT_RENDERED,
      text: RESULT_TEXT,
    },
  ],
} as const satisfies DesktopRegistrySearchResponse;
const SECOND_RESPONSE = {
  ...SEARCH_RESPONSE,
  results: [
    {
      id: "company-2",
      name: "Latest Company",
      rendered: "Latest result",
      text: "Latest result",
    },
  ],
} as const satisfies DesktopRegistrySearchResponse;
const FORMAT_RESPONSE = {
  rendered: FORMATTED_RENDERED,
  text: FORMATTED_TEXT,
} as const;
const PRIVATE_CLIPBOARD_TEXT =
  "Privileged synthetic clipboard text must stay local";
const CONNECTED_EXPIRES_AT = new Date(Date.now() + 86_400_000).toISOString();
const SNAPSHOT = {
  captureStatus: "active",
  groupLimit: 24,
  groups: [],
  items: [
    {
      copiedAt: "2026-09-08T05:00:00.000Z",
      groupId: null,
      groupedAt: null,
      id: "private-clip",
      name: "Local confidential note",
      plainText: PRIVATE_CLIPBOARD_TEXT,
      sourceApp: null,
      type: "text",
    },
  ],
  persistence: { imageCleanup: "idle", status: "encrypted" },
  retention: "month",
  screenCapture: "hidden",
  sourceAppExclusionLimit: 128,
  sourceAppExclusions: [],
  sourceAppVisuals: [],
  welcomeStatus: "completed",
} satisfies ClipboardSnapshot;

type Connection =
  | { status: "disconnected" }
  | { status: "expired" }
  | { status: "reconnectRequired" }
  | ({
      status: "connected";
      accountLabel: string;
      expiresAt: string;
    } & DesktopRegistryConfig);
type Invocation = { args: Record<string, unknown>; command: string };
type BoundaryMode =
  | "normal"
  | "reject-first-search"
  | "defer-first-search"
  | "reject-first-state"
  | "defer-first-state"
  | "reject-first-connect"
  | "reject-first-activity"
  | "reject-disconnect";
type BoundaryOptions = {
  mode?: BoundaryMode;
  welcome?: boolean;
  settings?: boolean;
};
const SETTINGS_SNAPSHOT = {
  bridgePort: 45_901,
  bridgeVersion: 19,
  capabilities: ["office-edit.v1", "self-host.connect", "account-link.v5"],
  notificationPreferences: {
    documentReady: true,
    revisionCreated: true,
    syncIssues: true,
  },
  runningSince: "2026-09-08T05:00:00.000Z",
  sessions: [],
  trustedSelfHostConnections: [],
  update: {
    baseUrl: null,
    channel: null,
    currentHash: null,
    currentVersion: null,
    lastCheckedAt: null,
    latestHash: null,
    latestVersion: null,
    status: "idle",
    statusMessage: "",
    updateAvailable: false,
    updateReady: false,
  },
} satisfies AppSnapshot;
type Audit = {
  consoleErrors: string[];
  external: string[];
  pageErrors: string[];
};
const audits = new WeakMap<Page, Audit>();

test.beforeEach(async ({ baseURL, page }) => {
  if (!baseURL) {
    throw new TypeError("Desktop browser tests require a base URL");
  }
  const allowedHttpOrigin = new URL(baseURL).origin;
  const allowedWebSocket = new URL(baseURL);
  allowedWebSocket.protocol =
    allowedWebSocket.protocol === "https:" ? "wss:" : "ws:";
  const audit: Audit = { consoleErrors: [], external: [], pageErrors: [] };
  audits.set(page, audit);
  page.on("console", (message) => {
    if (message.type() === "error") {
      audit.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => audit.pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== allowedHttpOrigin) {
      audit.external.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.routeWebSocket("**/*", async (socket) => {
    if (new URL(socket.url()).origin !== allowedWebSocket.origin) {
      audit.external.push(socket.url());
      await socket.close();
      return;
    }
    socket.connectToServer();
  });
});

test.afterEach(async ({ page }) => {
  const audit = audits.get(page);
  if (!audit) {
    throw new TypeError("Registry browser audit is not installed");
  }
  expect(audit.external).toEqual([]);
  expect(audit.pageErrors).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  if (!page.isClosed()) {
    expect(
      await page.evaluate(() =>
        Reflect.get(window, "__STELLA_REGISTRY_UNEXPECTED__"),
      ),
    ).toEqual([]);
  }
});

const installNativeBoundary = async (
  page: Page,
  connection: Connection,
  options: BoundaryMode | BoundaryOptions = "normal",
) => {
  const configuration =
    typeof options === "string" ? { mode: options } : options;
  const account = (
    connection.status === "connected"
      ? {
          status: "connected",
          account: {
            name: "Synthetic Member",
            email: "member@example.test",
            verifiedAt: "2026-09-08T05:00:00.000Z",
          },
          identity: {
            userId: "synthetic-user",
            organizationId: "synthetic-organization",
          },
          expiresAt: CONNECTED_EXPIRES_AT,
        }
      : { status: connection.status }
  ) satisfies DesktopAccountSnapshot;
  await page.addInitScript(
    ({
      initialConnection,
      initialMode,
      formatResponse,
      searchResponse,
      secondResponse,
      clipboardSnapshot,
      signedInConnection,
      settingsSnapshot,
      accountSnapshot,
      windowLabel,
    }) => {
      const invocations: Invocation[] = [];
      const unexpected: string[] = [];
      const callbacks = new Map<number, (data: unknown) => unknown>();
      let callbackId = 0;
      let searchCount = 0;
      let stateCount = 0;
      let connectCount = 0;
      let activityCount = 0;
      let telemetryEnabled = true;
      let resolveFirstState: ((value: Connection) => void) | null = null;
      let currentConnection = initialConnection;
      let resolveFirstSearch:
        | ((value: DesktopRegistrySearchResponse) => void)
        | null = null;
      Reflect.set(window, "__STELLA_RESOLVE_FIRST_STATE__", () =>
        resolveFirstState?.(currentConnection),
      );
      Reflect.set(window, "__STELLA_REGISTRY_INVOCATIONS__", invocations);
      Reflect.set(window, "__STELLA_REGISTRY_UNEXPECTED__", unexpected);
      Reflect.set(window, "__STELLA_COMPLETE_SIGN_IN__", () => {
        currentConnection = signedInConnection;
      });
      Reflect.set(window, "__STELLA_RESOLVE_FIRST_SEARCH__", () =>
        resolveFirstSearch?.(searchResponse),
      );
      Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        unregisterListener: () => undefined,
      });
      Reflect.set(window, "__TAURI_INTERNALS__", {
        callbacks,
        convertFileSrc: (path: string) => path,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          invocations.push({ args, command });
          switch (command) {
            case "account_disconnect":
              if (initialMode === "reject-disconnect") {
                throw new TypeError("Deliberate disconnect failure");
              }
              return undefined;
            case "account_record_use":
              activityCount += 1;
              if (Object.keys(args).length !== 0) {
                unexpected.push("account_record_use arguments");
                throw new TypeError("Account activity must not contain data");
              }
              if (
                initialMode === "reject-first-activity" &&
                activityCount === 1
              ) {
                throw new TypeError("Deliberate account activity failure");
              }
              return null;
            case "get_desktop_telemetry_enabled":
              return telemetryEnabled;
            case "set_desktop_telemetry_enabled":
              if (typeof args["enabled"] !== "boolean") {
                unexpected.push("set_desktop_telemetry_enabled arguments");
                throw new TypeError("Reporting preference must be a boolean");
              }
              telemetryEnabled = args["enabled"];
              return telemetryEnabled;
            case "get_desktop_language":
              return navigator.language === "ar" ? "ar" : "en";
            case "clipboard_get_snapshot":
              return clipboardSnapshot;
            case "clipboard_complete_welcome":
              return { ...clipboardSnapshot, welcomeStatus: "completed" };
            case "get_state":
              return settingsSnapshot;
            case "account_get_state":
              return accountSnapshot;
            case "open_stella_account":
              connectCount += 1;
              if (
                initialMode === "reject-first-connect" &&
                connectCount === 1
              ) {
                throw new TypeError("Deliberate connect failure");
              }
              return undefined;
            case "is_autostart_enabled":
              return false;
            case "plugin:event|listen":
              return args["handler"];
            case "plugin:event|unlisten":
            case "desktop_report_timing":
            case "desktop_report_error":
            case "clipboard_hide":
            case "registry_copy":
            case "registry_open_company_format":
              return undefined;
            case "registry_get_state": {
              stateCount += 1;
              if (initialMode === "reject-first-state" && stateCount === 1) {
                throw new TypeError("Deliberate connection failure");
              }
              if (initialMode === "defer-first-state" && stateCount === 1) {
                return await new Promise<Connection>((resolve) => {
                  resolveFirstState = resolve;
                });
              }
              return currentConnection;
            }
            case "registry_search": {
              searchCount += 1;
              if (initialMode === "reject-first-search" && searchCount === 1) {
                throw new TypeError("Deliberate registry search failure");
              }
              if (initialMode === "defer-first-search" && searchCount === 1) {
                return await new Promise<DesktopRegistrySearchResponse>(
                  (resolve) => {
                    resolveFirstSearch = resolve;
                  },
                );
              }
              return initialMode === "normal" ||
                initialMode === "reject-first-state"
                ? searchResponse
                : secondResponse;
            }
            case "registry_format":
              return formatResponse;
            case "registry_set_default_format": {
              // The API answers with the default the member now resolves to.
              // Clearing falls back to the firm's default, which this fixture
              // has: the same format the first search arrived with.
              const formatId = args["formatId"];
              return formatId === null
                ? {
                    defaultFormatId: searchResponse.defaultFormatId,
                    defaultFormatSource: searchResponse.defaultFormatSource,
                  }
                : { defaultFormatId: formatId, defaultFormatSource: "user" };
            }
            default:
              unexpected.push(command);
              throw new TypeError(`Unexpected native command: ${command}`);
          }
        },
        metadata: {
          currentWebview: { label: windowLabel, windowLabel },
          currentWindow: { label: windowLabel },
        },
        runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
        transformCallback: (
          callback: ((data: unknown) => unknown) | undefined,
          once = false,
        ) => {
          callbackId += 1;
          const id = callbackId;
          callbacks.set(id, (data) => {
            if (once) {
              callbacks.delete(id);
            }
            return callback?.(data);
          });
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
      });
    },
    {
      initialConnection: connection,
      initialMode: configuration.mode ?? "normal",
      formatResponse: FORMAT_RESPONSE,
      searchResponse: SEARCH_RESPONSE,
      secondResponse: SECOND_RESPONSE,
      clipboardSnapshot: {
        ...SNAPSHOT,
        welcomeStatus: configuration.welcome ? "pending" : "completed",
      },
      settingsSnapshot: SETTINGS_SNAPSHOT,
      accountSnapshot: account,
      windowLabel: configuration.settings ? "main" : "clipboard",
      signedInConnection: connected(),
    },
  );
};

const readInvocations = async (page: Page) =>
  page.evaluate(() => {
    const value: unknown = Reflect.get(
      window,
      "__STELLA_REGISTRY_INVOCATIONS__",
    );
    if (!Array.isArray(value)) {
      throw new TypeError("Registry invocation log is not installed");
    }
    return value.map((invocation): Invocation => {
      if (
        typeof invocation !== "object" ||
        invocation === null ||
        !("args" in invocation) ||
        typeof invocation.args !== "object" ||
        invocation.args === null ||
        !("command" in invocation) ||
        typeof invocation.command !== "string"
      ) {
        throw new TypeError("Registry invocation log contains an invalid call");
      }
      return { args: invocation.args, command: invocation.command };
    });
  });
const searches = async (page: Page) =>
  (await readInvocations(page)).filter(
    ({ command }) => command === "registry_search",
  );
const connected = (
  defaultRegistryId: DesktopRegistryConfig["defaultRegistryId"] = "ares",
): Connection => ({
  status: "connected",
  accountLabel: "https://api.example.test",
  expiresAt: CONNECTED_EXPIRES_AT,
  defaultRegistryId,
  registries: [...REGISTRIES],
});
const searchBox = (page: Page) => page.getByRole("searchbox");
const openClipboard = async (
  page: Page,
  connection = connected(),
  mode: BoundaryMode = "normal",
) => {
  await installNativeBoundary(page, connection, mode);
  await page.goto("/");
  await expect(page.locator("[data-clipboard-card-trigger]")).toBeVisible();
};
const switchScope = async (page: Page, key: "ArrowDown" | "ArrowUp") => {
  await page.locator("[data-clipboard-scope]").focus();
  await page.keyboard.press(key);
  await page.keyboard.press("Tab");
  await expect(searchBox(page)).toBeFocused();
};
const activateRegistry = async (page: Page, query = "Stella Example") => {
  await searchBox(page).fill(query);
  await switchScope(page, "ArrowDown");
  await expect(page.locator("[data-clipboard-scope]")).toHaveAttribute(
    "data-clipboard-scope",
    "registry",
  );
};

test("keeps typed queries local until the external action, including complete identifiers", async ({
  page,
}) => {
  await openClipboard(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  for (const query of [
    "Privileged",
    "27082440",
    "12345678",
    "Stella Example",
  ]) {
    await searchBox(page).fill(query);
    await page.clock.fastForward(600);
    expect(await searches(page)).toEqual([]);
  }
  await page.clock.resume();
  await activateRegistry(page);
  await expect
    .poll(async () => await searches(page))
    .toEqual([
      {
        command: "registry_search",
        args: { query: "Stella Example", registry: "ares" },
      },
    ]);
  expect(JSON.stringify(await searches(page))).not.toContain(
    PRIVATE_CLIPBOARD_TEXT,
  );
  await expect(searchBox(page)).toHaveCount(1);
  await expect(page).toHaveURL(/\/$/u);
});

test("sign-in stays available without disabling local clipboard search", async ({
  page,
}) => {
  await openClipboard(page, { status: "disconnected" });
  await searchBox(page).fill("Privileged");
  await expect(page.locator("[data-clipboard-card-trigger]")).toBeVisible();
  await activateRegistry(page);
  await expect(searchBox(page)).toBeEnabled();
  await page
    .getByRole("button", {
      name: enMessages.clipboard.registryConnect,
      exact: true,
    })
    .click();
  await expect
    .poll(async () => await readInvocations(page))
    .toContainEqual({ command: "open_stella_account", args: {} });
  expect(await searches(page)).toEqual([]);
});

test("keyboard activation retains the input and Enter never copies a hidden clipboard result", async ({
  page,
}) => {
  await openClipboard(page);
  await searchBox(page).fill("Privileged");
  await switchScope(page, "ArrowDown");
  await expect.poll(async () => (await searches(page)).length).toBe(1);
  await searchBox(page).press("Enter");
  expect(
    (await readInvocations(page)).filter(
      ({ command }) => command === "clipboard_copy_item",
    ),
  ).toEqual([]);
  await expect(searchBox(page)).toBeFocused();
});

test("highlights the first registry result and copies it with Enter from the search field", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page, "Privileged");
  const result = page.locator('[data-registry-result="company-1"]');
  await expect(result).toHaveAttribute("aria-current", "true");
  await expect(result.locator("strong")).toHaveText("ACME PLC");
  await expect(searchBox(page)).toBeFocused();
  await searchBox(page).press("Enter");
  await expect
    .poll(async () =>
      (await readInvocations(page)).filter(
        ({ command }) => command === "registry_copy",
      ),
    )
    .toEqual([
      {
        command: "registry_copy",
        args: { html: RESULT_HTML, text: RESULT_TEXT },
      },
    ]);
  await expect(searchBox(page)).toBeFocused();
  // ArrowUp lands on the highlighted card; ArrowDown returns to the field.
  await searchBox(page).press("ArrowUp");
  await expect(result.locator("[data-registry-card]")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(searchBox(page)).toBeFocused();
});

test("retains the explicitly requested query across browser sign-in and native focus return", async ({
  page,
}) => {
  await openClipboard(page, { status: "disconnected" });
  await activateRegistry(page, "Requested company");
  await page
    .getByRole("button", {
      name: enMessages.clipboard.registryConnect,
      exact: true,
    })
    .click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    const complete: unknown = Reflect.get(
      window,
      "__STELLA_COMPLETE_SIGN_IN__",
    );
    if (typeof complete !== "function") {
      throw new TypeError("Sign-in completion fixture is missing");
    }
    complete();
    window.dispatchEvent(new Event("focus"));
  });
  await expect(searchBox(page)).toHaveValue("Requested company");
  await expect
    .poll(async () => await searches(page))
    .toContainEqual({
      command: "registry_search",
      args: { query: "Requested company", registry: "ares" },
    });
  await expect(
    page.getByRole("heading", { name: "Stella Example s.r.o." }),
  ).toBeVisible();
});

test("refreshes the connection when the bridge stores a browser handoff", async ({
  page,
}) => {
  await openClipboard(page, { status: "disconnected" });
  await activateRegistry(page, "Requested company");
  await page
    .getByRole("button", {
      name: enMessages.clipboard.registryConnect,
      exact: true,
    })
    .click();
  await page.evaluate(() => {
    const complete: unknown = Reflect.get(
      window,
      "__STELLA_COMPLETE_SIGN_IN__",
    );
    if (typeof complete !== "function") {
      throw new TypeError("Sign-in completion fixture is missing");
    }
    complete();
    const invocations: unknown = Reflect.get(
      window,
      "__STELLA_REGISTRY_INVOCATIONS__",
    );
    if (!Array.isArray(invocations)) {
      throw new TypeError("Registry invocation fixture is missing");
    }
    const subscription = invocations.findLast(
      (entry: { args: Record<string, unknown>; command: string }) =>
        entry.command === "plugin:event|listen" &&
        entry.args["event"] === "desktop-account-changed",
    );
    const id = subscription?.args["handler"];
    if (typeof id !== "number") {
      throw new TypeError("Registry connection listener is not installed");
    }
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    const callbacks =
      typeof internals === "object" && internals !== null
        ? Reflect.get(internals, "callbacks")
        : undefined;
    if (!(callbacks instanceof Map)) {
      throw new TypeError("Tauri callback registry is missing");
    }
    callbacks.get(id)?.({
      event: "desktop-account-changed",
      id,
      payload: null,
    });
  });
  await expect
    .poll(async () => await searches(page))
    .toContainEqual({
      command: "registry_search",
      args: { query: "Requested company", registry: "ares" },
    });
  await expect(
    page.getByRole("heading", { name: "Stella Example s.r.o." }),
  ).toBeVisible();
});

test("retries an unavailable connection from the empty state", async ({
  page,
}) => {
  await openClipboard(page, connected(), "reject-first-state");
  await activateRegistry(page, "Requested company");
  await page
    .getByRole("button", {
      name: enMessages.clipboard.registryRetry,
      exact: true,
    })
    .click();
  await expect
    .poll(async () => await searches(page))
    .toContainEqual({
      command: "registry_search",
      args: { query: "Requested company", registry: "ares" },
    });
  await expect(
    page.getByRole("heading", { name: "Stella Example s.r.o." }),
  ).toBeVisible();
});

test("registry chooser owns its arrow keys and Escape without closing the clipboard", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page);
  const chooser = page.getByRole("button", {
    name: enMessages.clipboard.registrySelect,
  });
  await chooser.focus();
  await chooser.press("Enter");
  await expect(
    page.getByRole("menuitemradio", { name: "Companies House" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(searchBox(page)).not.toBeFocused();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  expect(
    (await readInvocations(page)).filter(
      ({ command }) => command === "clipboard_hide",
    ),
  ).toEqual([]);
});

test("the forward arrow leaves search for the active registry chooser", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page);
  const search = searchBox(page);
  const chooser = page.getByRole("button", {
    name: enMessages.clipboard.registrySelect,
  });
  await search.evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new TypeError("Search field is not an input");
    }
    input.setSelectionRange(input.value.length, input.value.length);
  });

  await page.keyboard.press("ArrowRight");
  await expect(chooser).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(search).toBeFocused();
});

test("switches system themes without animating page colours in unified search", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openClipboard(page);
  await activateRegistry(page);
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `#theme-transition-probe { background-color: rgb(255, 255, 255); transition: background-color 10s linear; }
      .dark #theme-transition-probe { background-color: rgb(0, 0, 0); }`;
    const probe = document.createElement("div");
    probe.id = "theme-transition-probe";
    document.head.append(style);
    document.body.append(probe);
  });
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
          const probe = document.querySelector("#theme-transition-probe");
          if (!(probe instanceof HTMLDivElement)) {
            throw new TypeError("Theme transition probe is missing");
          }
          return {
            animations: probe.getAnimations().length,
            colorScheme: document.documentElement.style.colorScheme,
            dark: document.documentElement.classList.contains("dark"),
            background: getComputedStyle(probe).backgroundColor,
          };
        }),
      )
      .toEqual({
        animations: 0,
        colorScheme: scheme,
        dark: scheme === "dark",
        background: scheme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
      });
  }
});

test("coalesces edits after explicit activation and cancels cleared queries without Enter", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page);
  await expect.poll(async () => (await searches(page)).length).toBe(1);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await searchBox(page).fill("First");
  await page.clock.fastForward(200);
  await searchBox(page).fill("  Final  ");
  await page.clock.fastForward(299);
  expect((await searches(page)).length).toBe(1);
  await page.clock.fastForward(1);
  await expect.poll(async () => await searches(page)).toHaveLength(2);
  expect((await searches(page)).at(-1)).toEqual({
    command: "registry_search",
    args: { query: "Final", registry: "ares" },
  });
  await searchBox(page).fill("Canceled");
  await page.clock.fastForward(299);
  await searchBox(page).fill("");
  await page.clock.fastForward(300);
  expect((await searches(page)).length).toBe(2);
  await searchBox(page).fill("27082440");
  await page.clock.fastForward(600);
  expect((await searches(page)).length).toBe(2);
  await expect(searchBox(page)).toBeFocused();
});

test("waits for composition to end before sending edited registry queries", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page);
  await expect.poll(async () => (await searches(page)).length).toBe(1);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const search = searchBox(page);
  await search.dispatchEvent("compositionstart");
  await search.fill("Composed");
  await page.clock.fastForward(500);
  expect((await searches(page)).length).toBe(1);
  await search.dispatchEvent("compositionend", { data: "Composed" });
  await page.clock.fastForward(299);
  expect((await searches(page)).length).toBe(1);
  await page.clock.fastForward(1);
  await expect
    .poll(async () => await searches(page))
    .toContainEqual({
      command: "registry_search",
      args: { query: "Composed", registry: "ares" },
    });
});

test("repeats the current query for a deliberately selected registry", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page);
  await page
    .getByRole("button", { name: enMessages.clipboard.registrySelect })
    .click();
  await page.getByRole("menuitemradio", { name: "Companies House" }).click();
  await expect
    .poll(async () => await searches(page))
    .toContainEqual({
      command: "registry_search",
      args: { query: "Stella Example", registry: "companies-house" },
    });
});

test("asks for a registry when saved practice settings do not identify one default", async ({
  page,
}) => {
  await openClipboard(page, connected(null));
  await activateRegistry(page);
  await page.clock.install();
  await page.clock.fastForward(600);
  expect(await searches(page)).toEqual([]);
  const chooser = page.getByRole("button", {
    name: enMessages.clipboard.registrySelect,
  });
  await expect(chooser).toHaveText(enMessages.clipboard.registrySelect);
  await chooser.click();
  await page.getByRole("menuitemradio", { name: "Companies House" }).click();
  await expect
    .poll(async () => await searches(page))
    .toEqual([
      {
        command: "registry_search",
        args: { query: "Stella Example", registry: "companies-house" },
      },
    ]);
});

test("ignores an older response after a newer search completes", async ({
  page,
}) => {
  await openClipboard(page, connected(), "defer-first-search");
  await activateRegistry(page, "First");
  await expect.poll(async () => (await searches(page)).length).toBe(1);
  await searchBox(page).fill("Second");
  await expect(
    page.getByRole("heading", { name: "Latest Company" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const resolve: unknown = Reflect.get(
      window,
      "__STELLA_RESOLVE_FIRST_SEARCH__",
    );
    if (typeof resolve !== "function") {
      throw new TypeError("Deferred search resolver is not installed");
    }
    resolve();
  });
  await expect(
    page.getByRole("heading", { name: "Stella Example s.r.o." }),
  ).toBeHidden();
  await expect(searchBox(page)).toHaveValue("Second");
  await expect(searchBox(page)).toBeFocused();
});

test("applies saved formatting and copies only the selected registry output", async ({
  page,
}) => {
  await openClipboard(page);
  await activateRegistry(page);
  const card = page.getByRole("button", { name: /Stella Example s\.r\.o\./u });
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Saved detailed" }).click();
  await expect(card).toContainText("Saved detailed registry output");
  await expect(card.locator("strong")).toHaveText("ACME PLC");
  await card.click();
  const calls = await readInvocations(page);
  expect(calls).toContainEqual({
    command: "registry_format",
    args: {
      formatId: "22222222-2222-4222-8222-222222222222",
      id: "company-1",
      registry: "ares",
    },
  });
  expect(calls).toContainEqual({
    command: "registry_copy",
    args: { html: FORMATTED_HTML, text: FORMATTED_TEXT },
  });
});

test("opens the selected company's specification formats from the format menu", async ({
  page,
}) => {
  await openClipboard(page, {
    status: "connected",
    accountLabel: "https://api.example.test",
    expiresAt: CONNECTED_EXPIRES_AT,
    defaultRegistryId: "ares",
    registries: [{ id: "ares", name: "Czech commercial registry" }],
  });
  await activateRegistry(page);
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page
    .getByRole("menuitem", {
      name: "Add a company specification template",
      exact: true,
    })
    .click();

  await expect
    .poll(async () => await readInvocations(page))
    .toContainEqual({
      command: "registry_open_company_format",
      args: { id: "company-1", registry: "ares" },
    });
});

test("labels non-company directory templates as registry results", async ({
  page,
}) => {
  await openClipboard(page, {
    status: "connected",
    accountLabel: "https://api.example.test",
    expiresAt: CONNECTED_EXPIRES_AT,
    defaultRegistryId: "denue",
    registries: [
      {
        id: "denue",
        name: "Mexico · INEGI DENUE",
        formatType: "registry-reference",
      },
    ],
  });
  await activateRegistry(page);
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page
    .getByRole("menuitem", {
      name: "Add a registry result template",
      exact: true,
    })
    .click();

  await expect
    .poll(async () => await readInvocations(page))
    .toContainEqual({
      command: "registry_open_company_format",
      args: { id: "company-1", registry: "denue" },
    });
});

for (const language of ["en", "ar"] as const) {
  test.describe(`${language} unified search`, () => {
    test.use({ locale: language });
    test("pins the organization default for the member and hands the choice back", async ({
      page,
    }) => {
      const messages = language === "ar" ? arMessages : enMessages;
      await openClipboard(page);
      await activateRegistry(page);
      const formatMenu = page.getByRole("button", {
        name: messages.clipboard.registryFormat,
        exact: true,
      });
      await expect(formatMenu).toHaveText(/Saved compact/u);

      // The effective default belongs to the organization, so the member can
      // pin the same format and keep it if the organization changes its own.
      await formatMenu.click();
      await page
        .getByRole("menuitem", {
          name: messages.clipboard.registryUseAsDefaultFormat,
        })
        .click();
      await expect
        .poll(async () => await readInvocations(page))
        .toContainEqual({
          command: "registry_set_default_format",
          args: {
            formatId: "11111111-1111-4111-8111-111111111111",
            registry: "ares",
          },
        });

      // Once it is the member's own default, the same row cannot be pinned
      // again. A different saved format remains available as a new choice.
      await formatMenu.click();
      await expect(
        page.getByRole("menuitem", {
          name: messages.clipboard.registryUseAsDefaultFormat,
        }),
      ).toBeHidden();
      await page.getByRole("menuitemradio", { name: "Saved detailed" }).click();
      await formatMenu.click();
      await page
        .getByRole("menuitem", {
          name: messages.clipboard.registryUseAsDefaultFormat,
        })
        .click();
      await expect
        .poll(async () => await readInvocations(page))
        .toContainEqual({
          command: "registry_set_default_format",
          args: {
            formatId: "22222222-2222-4222-8222-222222222222",
            registry: "ares",
          },
        });

      await formatMenu.click();
      await page
        .getByRole("menuitemradio", {
          name: messages.clipboard.registryDefaultFormat,
          exact: true,
        })
        .click();
      await formatMenu.click();
      await page
        .getByRole("menuitem", {
          name: messages.clipboard.registryClearDefaultFormat,
        })
        .click();
      await expect
        .poll(async () => await readInvocations(page))
        .toContainEqual({
          command: "registry_set_default_format",
          args: { formatId: null, registry: "ares" },
        });

      // The organization's default took over again, and the built-in entry
      // has no personal choice left to clear or pin.
      await formatMenu.click();
      await expect(
        page.getByRole("menuitem", {
          name: messages.clipboard.registryClearDefaultFormat,
        }),
      ).toBeHidden();
      await expect(
        page.getByRole("menuitem", {
          name: messages.clipboard.registryUseAsDefaultFormat,
        }),
      ).toBeHidden();
    });

    test("uses one bottom control frame and gives the top of the panel to results", async ({
      browserName,
      page,
    }) => {
      await openClipboard(page);
      await searchBox(page).fill("Privileged");
      // WebKit follows macOS keyboard access: Option+Tab includes buttons.
      await searchBox(page).press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      // The scope icon stays out of the tab order; the groups rail follows.
      await expect(
        page.locator('[data-clipboard-group-id="__no_group__"]'),
      ).toBeFocused();
      await searchBox(page).focus();
      const assertSingleFrame = async () => {
        const controls = page.locator("[data-registry-controls]");
        await expect(controls).toHaveCount(1);
        expect(
          await controls.evaluate((element) =>
            Boolean(element.closest(".clipboard-controls")),
          ),
        ).toBe(true);
        await expect(page.locator(".clipboard-controls")).toHaveCount(1);
        const layout = await page.evaluate(() => {
          const main = document.querySelector("main, [data-registry-results]");
          const footer = document.querySelector(".clipboard-controls");
          const registry = document.querySelector("[data-registry-controls]");
          if (!main || !footer || !registry) {
            throw new TypeError("Unified search frame is incomplete");
          }
          const mainBounds = main.getBoundingClientRect();
          const footerBounds = footer.getBoundingClientRect();
          const registryBounds = registry.getBoundingClientRect();
          return {
            mainTop: mainBounds.y,
            mainBottom: mainBounds.bottom,
            footerTop: footerBounds.y,
            footerBottom: footerBounds.bottom,
            registryTop: registryBounds.y,
            registryBottom: registryBounds.bottom,
            viewportHeight: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
          };
        });
        expect(layout.mainTop).toBeLessThanOrEqual(8);
        expect(layout.mainBottom).toBeLessThanOrEqual(layout.footerTop + 1);
        expect(layout.footerTop).toBeGreaterThanOrEqual(
          layout.viewportHeight - 64,
        );
        expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewportHeight);
        expect(layout.registryTop).toBeGreaterThanOrEqual(layout.footerTop);
        expect(layout.registryBottom).toBeLessThanOrEqual(layout.footerBottom);
        expect(layout.scrollHeight).toBeLessThanOrEqual(layout.viewportHeight);
      };
      await activateRegistry(page, "Privileged");
      await expect(
        page.getByRole("heading", { name: "Stella Example s.r.o." }),
      ).toBeVisible();
      await assertSingleFrame();
    });
    test("returns to local results with the same query and input focused", async ({
      page,
    }) => {
      await openClipboard(page);
      await activateRegistry(page, "Privileged");
      await expect(
        page.getByRole("heading", { name: "Stella Example s.r.o." }),
      ).toBeVisible();
      const before = await searches(page);
      await switchScope(page, "ArrowUp");
      await expect(searchBox(page)).toHaveValue("Privileged");
      await expect(searchBox(page)).toBeFocused();
      await expect(page.locator("[data-clipboard-card-trigger]")).toBeVisible();
      await searchBox(page).fill("27082440");
      await page.clock.install();
      await page.clock.fastForward(600);
      expect(await searches(page)).toEqual(before);
    });
    for (const colorScheme of ["light", "dark"] as const) {
      test(`shows failures quietly without moving controls in ${colorScheme}`, async ({
        page,
      }) => {
        const messages = language === "ar" ? arMessages : enMessages;
        await page.emulateMedia({ colorScheme });
        await openClipboard(page, connected(), "reject-first-search");
        const initialBounds = await searchBox(page).boundingBox();
        if (language === "en") {
          await searchBox(page).fill("Privileged");
          await page.screenshot({
            path: test.info().outputPath(`unified-clips-${colorScheme}.png`),
          });
        }
        await activateRegistry(page, "First");
        const alert = page.getByRole("alert");
        await expect(alert).toHaveText(messages.clipboard.registryErrorSearch);
        await expect(alert).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        expect(
          await alert.evaluate((element) =>
            Boolean(element.closest(".clipboard-controls")),
          ),
        ).toBe(true);
        await expect(searchBox(page)).toHaveAccessibleDescription(
          messages.clipboard.registryErrorSearch,
        );
        await expect(searchBox(page)).toBeFocused();
        expect(await searchBox(page).boundingBox()).toEqual(initialBounds);
        if (language === "en") {
          await page.screenshot({
            path: test.info().outputPath(`unified-error-${colorScheme}.png`),
          });
        }
        await searchBox(page).fill("Second");
        await expect(alert).toBeHidden();
        await expect(searchBox(page)).toHaveAccessibleDescription("");
        await expect(
          page.getByRole("heading", { name: "Latest Company" }),
        ).toBeVisible();
        if (language === "en") {
          await page.screenshot({
            path: test.info().outputPath(`unified-registry-${colorScheme}.png`),
          });
        }
      });
    }
  });
}

for (const language of ["en", "ar"] as const) {
  test.describe(`${language} first launch account connection`, () => {
    test.use({ locale: language });
    const messages = language === "ar" ? arMessages : enMessages;

    test("welcome connects through the existing account action without clipboard data", async ({
      page,
    }) => {
      await installNativeBoundary(
        page,
        { status: "disconnected" },
        { welcome: true },
      );
      await page.goto("/");
      const welcome = page.getByRole("dialog");
      await expect(welcome).toBeVisible();
      await expect(welcome).toHaveCSS(
        "direction",
        language === "ar" ? "rtl" : "ltr",
      );
      const connect = welcome.getByRole("button", {
        name: messages.settings.connectToStella,
        exact: true,
      });
      await expect(connect).toBeVisible();
      await connect.click();
      await expect
        .poll(async () =>
          (await readInvocations(page)).filter(
            ({ command }) => command === "open_stella_account",
          ),
        )
        .toEqual([{ command: "open_stella_account", args: {} }]);
      await expect(welcome).toBeVisible();
    });

    for (const status of [
      "connected",
      "disconnected",
      "expired",
      "reconnectRequired",
    ] as const) {
      test(`${status} welcome can finish without linking or opening an account`, async ({
        page,
      }) => {
        const connection = (
          status === "connected" ? connected() : { status }
        ) satisfies Connection;
        await installNativeBoundary(page, connection, { welcome: true });
        await page.goto("/");
        const welcome = page.getByRole("dialog");
        await expect(welcome).toBeVisible();
        await welcome
          .getByRole("button", {
            name: messages.clipboard.welcomeStart,
            exact: true,
          })
          .click();
        await expect(welcome).toHaveCount(0);
        await expect
          .poll(async () =>
            (await readInvocations(page)).filter(
              ({ command }) => command === "clipboard_complete_welcome",
            ),
          )
          .toEqual([{ command: "clipboard_complete_welcome", args: {} }]);
        expect(
          (await readInvocations(page)).filter(
            ({ command }) => command === "open_stella_account",
          ),
        ).toEqual([]);
        await expect(
          page.locator('[data-clipboard-id="private-clip"]'),
        ).toBeVisible();
      });
    }

    test("expired welcome explains expiry and reconnects through the existing account action", async ({
      page,
    }) => {
      await installNativeBoundary(
        page,
        { status: "expired" },
        { welcome: true },
      );
      await page.goto("/");
      const welcome = page.getByRole("dialog");
      await expect(
        welcome.getByText(messages.settings.connectionExpiredDescription, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.connectToStella,
          exact: true,
        }),
      ).toHaveCount(0);
      await welcome
        .getByRole("button", {
          name: messages.settings.reconnectToStella,
          exact: true,
        })
        .click();
      await expect
        .poll(async () =>
          (await readInvocations(page)).filter(
            ({ command }) => command === "open_stella_account",
          ),
        )
        .toEqual([{ command: "open_stella_account", args: {} }]);
      await expect(welcome).toBeVisible();
    });

    test("Settings can disable and re-enable crash and error reporting", async ({
      page,
    }) => {
      await installNativeBoundary(page, connected(), { settings: true });
      await page.goto("/#general");
      const reporting = page.getByRole("switch", {
        name: messages.settings.sendCrashReports,
        exact: true,
      });
      await expect(reporting).toBeEnabled();
      await expect(reporting).toBeChecked();
      await expect(
        page.getByText(messages.settings.sendCrashReportsDescription, {
          exact: true,
        }),
      ).toBeVisible();
      await reporting.click();
      await expect(reporting).not.toBeChecked();
      await expect(reporting).toBeEnabled();
      await reporting.click();
      await expect(reporting).toBeChecked();
      await expect
        .poll(async () =>
          (await readInvocations(page)).filter(
            ({ command }) => command === "set_desktop_telemetry_enabled",
          ),
        )
        .toEqual([
          {
            command: "set_desktop_telemetry_enabled",
            args: { enabled: false },
          },
          { command: "set_desktop_telemetry_enabled", args: { enabled: true } },
        ]);
    });

    test("expired Settings shows an expiry badge and offers reconnect", async ({
      page,
    }) => {
      await installNativeBoundary(
        page,
        { status: "expired" },
        { settings: true },
      );
      await page.goto("/#general");
      await expect(
        page.getByText(messages.settings.connectionExpired, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(messages.settings.connectionExpiredDescription, {
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", {
          name: messages.settings.connectToStella,
          exact: true,
        }),
      ).toHaveCount(0);
      await page
        .getByRole("button", {
          name: messages.settings.reconnectToStella,
          exact: true,
        })
        .click();
      await expect
        .poll(async () =>
          (await readInvocations(page)).filter(
            ({ command }) => command === "open_stella_account",
          ),
        )
        .toEqual([{ command: "open_stella_account", args: {} }]);
    });

    test("expired registry requests reconnection instead of searching", async ({
      page,
    }) => {
      await openClipboard(page, { status: "expired" });
      await activateRegistry(page, "Synthetic company");
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: messages.settings.connectionExpiredDescription }),
      ).toBeVisible();
      expect(await searches(page)).toEqual([]);
      await page
        .getByRole("button", {
          name: messages.settings.reconnectToStella,
          exact: true,
        })
        .click();
      await expect
        .poll(async () =>
          (await readInvocations(page)).filter(
            ({ command }) => command === "open_stella_account",
          ),
        )
        .toEqual([{ command: "open_stella_account", args: {} }]);
    });

    for (const surface of ["welcome", "settings", "registry"] as const) {
      for (const mode of ["normal", "reject-disconnect"] as const) {
        test(`${surface} missing device key reconnect ${mode} clears credentials before opening the account`, async ({
          page,
        }) => {
          await installNativeBoundary(
            page,
            { status: "reconnectRequired" },
            {
              mode,
              welcome: surface === "welcome",
              settings: surface === "settings",
            },
          );
          await page.goto(surface === "settings" ? "/#general" : "/");
          if (surface === "registry") {
            await activateRegistry(page, "Synthetic company");
            expect(await searches(page)).toEqual([]);
          }
          const area = surface === "welcome" ? page.getByRole("dialog") : page;
          if (surface === "settings") {
            await expect(
              page.getByText(messages.settings.notConnected, { exact: true }),
            ).toBeVisible();
          }
          await area
            .getByRole("button", {
              name: messages.settings.reconnectToStella,
              exact: true,
            })
            .click();
          const accountActions = async () =>
            (await readInvocations(page)).filter(
              ({ command }) =>
                command === "account_disconnect" ||
                command === "open_stella_account",
            );
          if (mode === "normal") {
            await expect.poll(accountActions).toEqual([
              { command: "account_disconnect", args: {} },
              { command: "open_stella_account", args: {} },
            ]);
          } else {
            const error =
              surface === "settings"
                ? "Deliberate disconnect failure"
                : messages.clipboard.registryErrorConnect;
            if (surface === "settings") {
              await expect(
                page.getByText(error, { exact: true }),
              ).toBeVisible();
            } else {
              await expect(area.getByRole("alert")).toHaveText(error);
            }
            expect(await accountActions()).toEqual([
              { command: "account_disconnect", args: {} },
            ]);
            await expect(
              area.getByRole("button", {
                name: messages.settings.reconnectToStella,
                exact: true,
              }),
            ).toBeVisible();
          }
          expect(await searches(page)).toEqual([]);
          if (surface === "welcome") {
            await expect(page.getByRole("dialog")).toBeVisible();
          }
        });
      }
    }

    test("connected welcome omits the connect prompt", async ({ page }) => {
      await installNativeBoundary(page, connected(), { welcome: true });
      await page.goto("/");
      const welcome = page.getByRole("dialog");
      await expect(welcome).toBeVisible();
      await expect
        .poll(
          async () =>
            (await readInvocations(page)).filter(
              ({ command }) => command === "registry_get_state",
            ).length,
        )
        .toBeGreaterThan(0);
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        });
      });
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.connectToStella,
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        welcome.getByText(messages.settings.connectToStellaDescription, {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        welcome.getByRole("button", {
          name: messages.clipboard.welcomeStart,
          exact: true,
        }),
      ).toBeEnabled();
    });

    test("loading welcome never pretends the account is disconnected", async ({
      page,
    }) => {
      await installNativeBoundary(
        page,
        { status: "disconnected" },
        { welcome: true, mode: "defer-first-state" },
      );
      await page.goto("/");
      const welcome = page.getByRole("dialog");
      await expect(welcome).toBeVisible();
      // Wait for the requested messages before asserting the loading state.
      await expect(
        welcome.getByRole("button", {
          name: messages.clipboard.welcomeStart,
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.connectToStella,
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.tryAgain,
          exact: true,
        }),
      ).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await readInvocations(page)).filter(
              ({ command }) => command === "registry_get_state",
            ).length,
        )
        .toBe(1);
      await page.evaluate(() => {
        const resolve = Reflect.get(window, "__STELLA_RESOLVE_FIRST_STATE__");
        if (typeof resolve !== "function") {
          throw new TypeError("Missing state resolver");
        }
        resolve();
      });
      await expect(
        welcome.getByRole("button", {
          name: messages.clipboard.welcomeStart,
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.connectToStella,
          exact: true,
        }),
      ).toBeVisible();
    });

    test("failed connection lookup exposes retry and recovers", async ({
      page,
    }) => {
      await installNativeBoundary(page, connected(), {
        welcome: true,
        mode: "reject-first-state",
      });
      await page.goto("/");
      const welcome = page.getByRole("dialog");
      await expect(welcome.getByRole("alert")).toHaveText(
        messages.clipboard.registryErrorState,
      );
      expect(
        (await readInvocations(page)).filter(
          ({ command }) => command === "registry_get_state",
        ),
      ).toHaveLength(1);
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.connectToStella,
          exact: true,
        }),
      ).toHaveCount(0);
      await welcome
        .getByRole("button", { name: messages.settings.tryAgain, exact: true })
        .click();
      await expect(welcome.getByRole("alert")).toHaveCount(0);
      expect(
        (await readInvocations(page)).filter(
          ({ command }) => command === "registry_get_state",
        ),
      ).toHaveLength(2);
      await expect(
        welcome.getByRole("button", {
          name: messages.settings.tryAgain,
          exact: true,
        }),
      ).toHaveCount(0);
    });

    test("failed connect remains recoverable through the same account action", async ({
      page,
    }) => {
      await installNativeBoundary(
        page,
        { status: "disconnected" },
        { welcome: true, mode: "reject-first-connect" },
      );
      await page.goto("/");
      const welcome = page.getByRole("dialog");
      const connect = welcome.getByRole("button", {
        name: messages.settings.connectToStella,
        exact: true,
      });
      await connect.click();
      await expect(welcome.getByRole("alert")).toHaveText(
        messages.clipboard.registryErrorConnect,
      );
      await connect.click();
      await expect(welcome.getByRole("alert")).toHaveCount(0);
      await expect
        .poll(async () =>
          (await readInvocations(page)).filter(
            ({ command }) => command === "open_stella_account",
          ),
        )
        .toEqual([
          { command: "open_stella_account", args: {} },
          { command: "open_stella_account", args: {} },
        ]);
    });

    for (const status of ["connected", "disconnected"] as const) {
      test(`${status} Settings header keeps its complete subtitle at the native window size`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 480, height: 460 });
        await installNativeBoundary(
          page,
          status === "connected" ? connected() : { status: "disconnected" },
          { settings: true },
        );
        await page.goto("/#general");
        const subtitle = page.getByText(
          status === "connected"
            ? "member@example.test"
            : messages.settings.desktopBenefit,
          { exact: true },
        );
        await expect(subtitle).toHaveCount(1);
        await expect(subtitle).toBeVisible();
        if (status === "connected") {
          await expect(
            page.getByText("Synthetic Member", { exact: true }),
          ).toBeVisible();
        } else {
          await expect(
            page.getByText(messages.settings.connectToStellaDescription, {
              exact: true,
            }),
          ).toHaveCount(1);
        }
        await expect(subtitle).toHaveCSS(
          "direction",
          language === "ar" ? "rtl" : "ltr",
        );
        const geometry = await subtitle.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
            height: element.clientHeight,
            scrollHeight: element.scrollHeight,
          };
        });
        expect(geometry.textOverflow).not.toBe("ellipsis");
        expect(geometry.whiteSpace).not.toBe("nowrap");
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
        expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height);
      });
    }
  });
}

test("clipboard activity is paced and never sends clipboard or keyboard contents", async ({
  page,
}) => {
  await page.clock.install();
  await openClipboard(page);
  expect(
    (await readInvocations(page)).filter(
      ({ command }) => command === "account_record_use",
    ),
  ).toEqual([]);
  await searchBox(page).click();
  await page.keyboard.type(PRIVATE_CLIPBOARD_TEXT);
  await expect
    .poll(async () =>
      (await readInvocations(page)).filter(
        ({ command }) => command === "account_record_use",
      ),
    )
    .toEqual([{ command: "account_record_use", args: {} }]);
  await page.clock.fastForward(30_000);
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () =>
      (await readInvocations(page)).filter(
        ({ command }) => command === "account_record_use",
      ),
    )
    .toEqual([
      { command: "account_record_use", args: {} },
      { command: "account_record_use", args: {} },
    ]);
});

test("native refresh and synthetic input do not count as account activity", async ({
  page,
}) => {
  await openClipboard(page);
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(
      async () =>
        (await readInvocations(page)).filter(
          ({ command }) => command === "registry_get_state",
        ).length,
    )
    .toBeGreaterThan(1);
  expect(
    (await readInvocations(page)).filter(
      ({ command }) => command === "account_record_use",
    ),
  ).toEqual([]);
});

test("foreground Settings interactions record use without passing event data", async ({
  page,
}) => {
  await installNativeBoundary(page, connected(), { settings: true });
  await page.goto("/#general");
  await page
    .getByRole("tab", { name: enMessages.settings.general, exact: true })
    .click();
  await expect
    .poll(async () =>
      (await readInvocations(page)).filter(
        ({ command }) => command === "account_record_use",
      ),
    )
    .toEqual([{ command: "account_record_use", args: {} }]);
});

test("activity failure reports only the existing telemetry classification", async ({
  page,
}) => {
  await openClipboard(page, connected(), "reject-first-activity");
  await searchBox(page).click();
  await expect
    .poll(async () =>
      (await readInvocations(page)).filter(
        ({ command }) => command === "desktop_report_error",
      ),
    )
    .toEqual([
      {
        command: "desktop_report_error",
        args: {
          report: {
            code: "invokeFailed",
            operation: "runtime",
            window: "clipboard",
          },
        },
      },
    ]);
});
