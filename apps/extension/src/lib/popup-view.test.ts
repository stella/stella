import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DESKTOP_LINK_STATE } from "./desktop-link";
import {
  containedTabRows,
  desktopLineStatus,
  type PopupActiveTab,
  type PopupController,
  type PopupMessageKey,
  popupView,
  type PopupWebsiteView,
  websiteLineStatus,
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
const handedTabs = [false, true] as const;

const everyInput = function* () {
  for (const granted of grants) {
    for (const controller of controllers) {
      for (const activeTab of activeTabs) {
        for (const handedTab of handedTabs) {
          yield { activeTab, controller, granted, handedTab };
        }
      }
    }
  }
};

const CONTROLLER = { origin: "https://app.stll.app" } as const;
const STELLA_TAB = activeTabs[0];
const STELLA_TAB_ELSEWHERE = activeTabs[2];
const SITE_TAB = { kind: "controllable" } as const;
const OTHER_TAB = { kind: "unsupported" } as const;
const connectButton = (
  askAccess: boolean,
  tabId: number | null,
): PopupWebsiteView => ({
  connect: { action: "connect-website", askAccess, tabId },
  type: "connect",
});
const connectedLine = {
  origin: "https://app.stll.app",
  type: "connected",
} as const satisfies PopupWebsiteView;

describe("the stella website line", () => {
  const cases = [
    {
      name: "first time, on a stella tab: one click asks for access and connects this tab",
      input: { activeTab: STELLA_TAB, controller: null, granted: false },
      view: { footer: [], offerTab: false, website: connectButton(true, 1) },
    },
    {
      name: "first time, elsewhere: one click asks for access, then opens stella and connects it",
      input: { activeTab: SITE_TAB, controller: null, granted: false },
      view: { footer: [], offerTab: false, website: connectButton(true, null) },
    },
    {
      name: "access granted, not connected: Connect opens stella without asking again",
      input: { activeTab: OTHER_TAB, controller: null, granted: true },
      view: {
        footer: ["revoke"],
        offerTab: false,
        website: connectButton(false, null),
      },
    },
    {
      name: "connected, access since removed in Chrome: Connect asks again",
      input: { activeTab: SITE_TAB, controller: CONTROLLER, granted: false },
      view: {
        footer: ["disconnect"],
        offerTab: false,
        website: connectButton(true, null),
      },
    },
    {
      name: "connected, another stella tab on the same origin in front",
      input: {
        activeTab: activeTabs[1],
        controller: CONTROLLER,
        granted: true,
      },
      view: {
        footer: ["disconnect", "revoke"],
        offerTab: false,
        website: connectedLine,
      },
    },
    {
      name: "connected, a stella tab on another origin in front: Connect moves the connection here",
      input: {
        activeTab: STELLA_TAB_ELSEWHERE,
        controller: CONTROLLER,
        granted: true,
      },
      view: {
        footer: ["disconnect", "revoke"],
        offerTab: false,
        website: connectButton(false, 3),
      },
    },
    {
      name: "connected, on a normal site: the tab can be handed to stella",
      input: { activeTab: SITE_TAB, controller: CONTROLLER, granted: true },
      view: {
        footer: ["disconnect", "revoke"],
        offerTab: true,
        website: connectedLine,
      },
    },
    {
      name: "connected, the site in front just handed over",
      input: {
        activeTab: SITE_TAB,
        controller: CONTROLLER,
        granted: true,
        handedTab: true,
      },
      view: {
        footer: ["disconnect", "revoke"],
        offerTab: false,
        website: connectedLine,
      },
    },
    {
      name: "connected, on a page stella cannot use",
      input: { activeTab: OTHER_TAB, controller: CONTROLLER, granted: true },
      view: {
        footer: ["disconnect", "revoke"],
        offerTab: false,
        website: connectedLine,
      },
    },
  ] as const;

  for (const { input, name, view } of cases) {
    test(name, () => {
      const actual = popupView(input);
      expect({
        ...actual,
        footer: actual.footer.map(({ action }) => action),
      }).toEqual({ ...view, footer: [...view.footer] });
    });
  }

  test("never says connected without a connection and website access", () => {
    for (const input of everyInput()) {
      const view = popupView(input);
      if (view.website.type === "connected") {
        expect(input.controller).not.toBeNull();
        expect(input.granted).toBe(true);
      }
      expect(websiteLineStatus(view)).toEqual(
        view.website.type === "connected"
          ? { messageKey: "statusConnected", tone: "connected", type: "status" }
          : { type: "connect" },
      );
    }
  });

  test("asks Chrome for access only when it has not granted it", () => {
    for (const input of everyInput()) {
      const { website } = popupView(input);
      if (website.type === "connect") {
        expect(website.connect.askAccess).toBe(!input.granted);
      }
    }
  });
});

describe("the stella desktop app line", () => {
  test("is the Connect button until the member allows it", () => {
    for (const state of Object.values(DESKTOP_LINK_STATE)) {
      expect(desktopLineStatus({ allowed: false, state })).toEqual({
        type: "connect",
      });
    }
  });

  test("once allowed, offers nothing to click and says connected only once the app answered", () => {
    expect(
      desktopLineStatus({ allowed: true, state: DESKTOP_LINK_STATE.connected }),
    ).toEqual({
      messageKey: "statusConnected",
      tone: "connected",
      type: "status",
    });
    expect(
      desktopLineStatus({ allowed: true, state: DESKTOP_LINK_STATE.waiting }),
    ).toEqual({ messageKey: "lineConnecting", tone: "idle", type: "status" });
    expect(
      desktopLineStatus({ allowed: true, state: DESKTOP_LINK_STATE.offline }),
    ).toEqual({ messageKey: "lineOpenApp", tone: "idle", type: "status" });
    expect(
      desktopLineStatus({
        allowed: true,
        state: DESKTOP_LINK_STATE.incompatible,
      }),
    ).toEqual({
      detailKey: "desktopUpdateNeeded",
      messageKey: "lineUpdateApp",
      tone: "warning",
      type: "status",
    });
  });
});

const returnedMessageKeys = new Set<PopupMessageKey>();
for (const input of everyInput()) {
  const view = popupView(input);
  const line = websiteLineStatus(view);
  if (line.type === "status") {
    returnedMessageKeys.add(line.messageKey);
  }
  for (const { messageKey } of view.footer) {
    returnedMessageKeys.add(messageKey);
  }
}
for (const allowed of grants) {
  for (const state of Object.values(DESKTOP_LINK_STATE)) {
    const line = desktopLineStatus({ allowed, state });
    if (line.type === "status") {
      returnedMessageKeys.add(line.messageKey);
      if (line.detailKey !== undefined) {
        returnedMessageKeys.add(line.detailKey);
      }
    }
  }
}
// Shown by the popup outside the view.
for (const key of [
  "adoptTab",
  "connectionPurpose",
  "lineConnect",
  "lineDesktop",
  "lineWebsite",
  "usingTabs",
] as const satisfies readonly PopupMessageKey[]) {
  returnedMessageKeys.add(key);
}

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
      new Bun.Glob("src/**/*.ts").scan({ cwd: fileURLToPath(extensionRoot) }),
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
