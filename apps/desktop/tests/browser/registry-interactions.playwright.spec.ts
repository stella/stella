import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type {
  DesktopRegistryConfig,
  DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";

import type { ClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import arMessages from "../../src/i18n/langs/ar.json" with { type: "json" };
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };

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
const SEARCH_RESPONSE = {
  defaultFormatId: "11111111-1111-4111-8111-111111111111",
  formats: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Saved compact" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Saved detailed" },
  ],
  results: [
    { id: "company-1", name: "Stella Example s.r.o.", text: "Registry result" },
  ],
} as const satisfies DesktopRegistrySearchResponse;
const SECOND_RESPONSE = {
  ...SEARCH_RESPONSE,
  results: [{ id: "company-2", name: "Latest Company", text: "Latest result" }],
} as const satisfies DesktopRegistrySearchResponse;
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
  sourceAppVisuals: [],
  welcomeStatus: "completed",
} satisfies ClipboardSnapshot;

type Connection =
  | { status: "disconnected" }
  | ({
      status: "connected";
      accountLabel: string;
      expiresAt: string;
    } & DesktopRegistryConfig);
type Invocation = { args: Record<string, unknown>; command: string };
type BoundaryMode = "normal" | "reject-first-search" | "defer-first-search";
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
  mode: BoundaryMode = "normal",
) => {
  await page.addInitScript(
    ({
      initialConnection,
      initialMode,
      searchResponse,
      secondResponse,
      clipboardSnapshot,
      signedInConnection,
    }) => {
      const invocations: Invocation[] = [];
      const unexpected: string[] = [];
      const callbacks = new Map<number, (data: unknown) => unknown>();
      let callbackId = 0;
      let searchCount = 0;
      let currentConnection = initialConnection;
      let resolveFirstSearch:
        | ((value: DesktopRegistrySearchResponse) => void)
        | null = null;
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
            case "get_desktop_language":
              return navigator.language === "ar" ? "ar" : "en";
            case "clipboard_get_snapshot":
              return clipboardSnapshot;
            case "is_autostart_enabled":
              return false;
            case "plugin:event|listen":
              return args["handler"];
            case "plugin:event|unlisten":
            case "desktop_report_timing":
            case "desktop_report_error":
            case "clipboard_hide":
            case "open_stella_account":
            case "account_disconnect":
            case "registry_copy":
            case "registry_open_company_format":
              return undefined;
            case "registry_get_state":
              return currentConnection;
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
              return initialMode === "normal" ? searchResponse : secondResponse;
            }
            case "registry_format":
              return { text: "Saved detailed registry output" };
            default:
              unexpected.push(command);
              throw new TypeError(`Unexpected native command: ${command}`);
          }
        },
        metadata: {
          currentWebview: { label: "clipboard", windowLabel: "clipboard" },
          currentWindow: { label: "clipboard" },
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
      initialMode: mode,
      searchResponse: SEARCH_RESPONSE,
      secondResponse: SECOND_RESPONSE,
      clipboardSnapshot: SNAPSHOT,
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
  await expect(searchBox(page)).toBeFocused();
  await searchBox(page).press("Enter");
  await expect
    .poll(async () =>
      (await readInvocations(page)).filter(
        ({ command }) => command === "registry_copy",
      ),
    )
    .toEqual([{ command: "registry_copy", args: { text: "Registry result" } }]);
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
    args: { text: "Saved detailed registry output" },
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
