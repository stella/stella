import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { DESKTOP_LINK_STATE } from "./desktop-link";
import {
  connectedOrigin,
  containedTabRows,
  desktopLinkView,
  handedTabView,
  type PopupActiveTab,
  type PopupController,
  type PopupMessageKey,
  popupView,
} from "./popup-view";

const activeTabs = [
  { kind: "stella", origin: "https://app.stll.app", tabId: 1 },
  // A second tab on the connected origin shares its connection.
  { kind: "stella", origin: "https://app.stll.app", tabId: 2 },
  { kind: "stella", origin: "https://my.stll.app", tabId: 3 },
  { kind: "controllable" },
  { kind: "unsupported" },
] as const satisfies readonly PopupActiveTab[];
const controllers = [
  null,
  { origin: "https://app.stll.app" },
] as const satisfies readonly (PopupController | null)[];
const grants = [false, true] as const;

describe("popupView", () => {
  for (const granted of grants) {
    for (const controller of controllers) {
      for (const activeTab of activeTabs) {
        test(`${granted ? "granted" : "not granted"}, ${controller ? "controller" : "no controller"}, ${activeTab.kind}${activeTab.kind === "stella" ? ` tab ${activeTab.tabId}` : ""}`, () => {
          const view = popupView({ activeTab, controller, granted });
          if (!granted) {
            expect(view.state.type).toBe("website-access-needed");
            expect(view.primary?.action).toBe(
              activeTab.kind === "stella" ? "grant-and-connect" : "grant",
            );
            expect(view.secondary.map(({ action }) => action)).toEqual(
              controller === null ? [] : ["disconnect"],
            );
            return;
          }
          if (controller === null && activeTab.kind === "stella") {
            expect(view.state.type).toBe("not-connected");
            expect(view.primary?.action).toBe("connect");
            expect(view.secondary.map(({ action }) => action)).toEqual([
              "revoke",
            ]);
            return;
          }
          if (controller === null) {
            expect(view.state.type).toBe("open-stella-to-connect");
            expect(view.primary).toBeNull();
            expect(view.secondary.map(({ action }) => action)).toEqual([
              "revoke",
            ]);
            return;
          }
          if (
            activeTab.kind === "stella" &&
            activeTab.origin !== controller.origin
          ) {
            expect(view).toEqual({
              primary: {
                action: "connect",
                messageKey: "connectStellaInstead",
              },
              secondary: [
                {
                  action: "disconnect",
                  appearance: "button",
                  messageKey: "disconnectTab",
                },
                {
                  action: "revoke",
                  appearance: "link",
                  messageKey: "revokeAccess",
                },
              ],
              showPurpose: false,
              state: { type: "connected-elsewhere" },
              statusMessageKey: "statusConnectedElsewhere",
            });
            return;
          }
          expect(view.statusMessageKey).toBe("statusConnected");
          expect(view.state).toEqual({
            origin: "https://app.stll.app",
            type: "connected",
          });
          expect(view.primary?.action ?? null).toBe(
            activeTab.kind === "controllable" ? "adopt" : null,
          );
          expect(view.secondary.map(({ action }) => action)).toEqual([
            "disconnect",
            "revoke",
          ]);
        });
      }
    }
  }

  test("cannot show connected without a controller", () => {
    for (const activeTab of activeTabs) {
      expect(
        popupView({ activeTab, controller: null, granted: true }).state.type,
      ).not.toBe("connected");
    }
  });

  test("represents a tab handed to stella after adoption", () => {
    expect(handedTabView("https://example.com")).toMatchObject({
      primary: null,
      showPurpose: false,
      state: { origin: "https://example.com", type: "tab-handed-to-stella" },
      statusMessageKey: "statusConnected",
    });
  });

  test("says what connecting does only until stella is connected", () => {
    for (const granted of grants) {
      for (const controller of controllers) {
        for (const activeTab of activeTabs) {
          const view = popupView({ activeTab, controller, granted });
          expect(view.showPurpose).toBe(
            !granted ||
              view.state.type === "not-connected" ||
              view.state.type === "open-stella-to-connect",
          );
        }
      }
    }
  });

  test("names the connected address only while connected here", () => {
    for (const granted of grants) {
      for (const controller of controllers) {
        for (const activeTab of activeTabs) {
          const view = popupView({ activeTab, controller, granted });
          expect(connectedOrigin(view)).toBe(
            view.state.type === "connected" ? "https://app.stll.app" : null,
          );
        }
      }
    }
    expect(connectedOrigin(handedTabView("https://app.stll.app"))).toBe(
      "https://app.stll.app",
    );
  });
});

const returnedMessageKeys = new Set<PopupMessageKey>();
for (const granted of grants) {
  for (const controller of controllers) {
    for (const activeTab of activeTabs) {
      const view = popupView({ activeTab, controller, granted });
      returnedMessageKeys.add(view.statusMessageKey);
      if (view.primary) {
        returnedMessageKeys.add(view.primary.messageKey);
      }
      for (const secondary of view.secondary) {
        returnedMessageKeys.add(secondary.messageKey);
      }
    }
  }
}
const handed = handedTabView("https://example.com");
returnedMessageKeys.add(handed.statusMessageKey);
for (const allowed of grants) {
  for (const state of Object.values(DESKTOP_LINK_STATE)) {
    returnedMessageKeys.add(desktopLinkView({ allowed, state }).messageKey);
  }
}
// Shown by the popup outside the view.
for (const key of [
  "checkingAccess",
  "connectionPurpose",
  "usingTabs",
] as const satisfies readonly PopupMessageKey[]) {
  returnedMessageKeys.add(key);
}

describe("the stella desktop row", () => {
  test("offers the permission until the member allows it", () => {
    for (const state of Object.values(DESKTOP_LINK_STATE)) {
      expect(desktopLinkView({ allowed: false, state })).toEqual({
        messageKey: "allowDesktop",
        type: "allow",
      });
    }
  });

  test("says connected only once stella desktop answered", () => {
    expect(
      desktopLinkView({ allowed: true, state: DESKTOP_LINK_STATE.connected }),
    ).toEqual({ messageKey: "desktopConnected", type: "connected" });
    for (const state of [
      DESKTOP_LINK_STATE.offline,
      DESKTOP_LINK_STATE.waiting,
    ]) {
      expect(desktopLinkView({ allowed: true, state }).type).toBe(
        "not-running",
      );
    }
  });
});

describe("naming the tabs stella keeps contained", () => {
  test("a tab is named by its title, with its host beside it", () => {
    expect(
      containedTabRows([
        {
          title: "  Invoices ",
          url: "https://portal.example.com/invoices?page=2",
        },
      ]),
    ).toEqual([{ host: "portal.example.com", name: "Invoices" }]);
  });

  test("whichever of title and host Chrome reported names the tab", () => {
    expect(
      containedTabRows([
        { title: "  ", url: "https://portal.example.com/" },
        { title: "portal.example.com", url: "https://portal.example.com/" },
        { title: "Loading", url: "about:blank" },
        { title: "Broken", url: "not a url" },
      ]),
    ).toEqual([
      { host: null, name: "portal.example.com" },
      { host: null, name: "portal.example.com" },
      { host: null, name: "Loading" },
      { host: null, name: "Broken" },
    ]);
  });

  test("a tab Chrome told nothing about is left out, the order kept", () => {
    expect(
      containedTabRows([
        { title: "Invoices", url: "https://portal.example.com/" },
        {},
        { title: "Report", url: "https://files.example.net/r" },
      ]),
    ).toEqual([
      { host: "portal.example.com", name: "Invoices" },
      { host: "files.example.net", name: "Report" },
    ]);
    expect(containedTabRows([])).toEqual([]);
  });
});

test("every locale contains every message returned by the view", async () => {
  const localesRoot = new URL("../../public/_locales/", import.meta.url);
  for (const locale of await readdir(localesRoot)) {
    const messages = await Bun.file(
      new URL(`${locale}/messages.json`, localesRoot),
    ).json();
    for (const key of returnedMessageKeys) {
      expect(messages, `${locale} is missing ${key}`).toHaveProperty(key);
    }
  }
});

test("Czech and Slovak messages contain no en or em dashes", async () => {
  for (const locale of ["cs", "sk"]) {
    const text = await Bun.file(
      new URL(`../../public/_locales/${locale}/messages.json`, import.meta.url),
    ).text();
    expect(text).not.toMatch(/[–—]/u);
  }
});

test("every locale has exactly the English messages, none left unused", async () => {
  const localesRoot = new URL("../../public/_locales/", import.meta.url);
  const english = Object.keys(
    await Bun.file(new URL("en/messages.json", localesRoot)).json(),
  ).toSorted();
  for (const locale of await readdir(localesRoot)) {
    const keys = Object.keys(
      await Bun.file(new URL(`${locale}/messages.json`, localesRoot)).json(),
    ).toSorted();
    expect(keys, locale).toEqual(english);
  }
  const extensionRoot = new URL("../../", import.meta.url);
  const files = [
    ...(await Array.fromAsync(
      new Bun.Glob("src/**/*.ts").scan({ cwd: extensionRoot.pathname }),
    )),
    "wxt.config.ts",
  ];
  const sources = await Promise.all(
    files
      .filter((file) => !file.endsWith(".test.ts"))
      .map(async (file) => await Bun.file(new URL(file, extensionRoot)).text()),
  );
  const text = sources.join("\n");
  for (const key of english) {
    expect(
      text.includes(`"${key}"`) || text.includes(`__MSG_${key}__`),
      `${key} is not used`,
    ).toBe(true);
  }
});
