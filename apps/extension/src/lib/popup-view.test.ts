import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import {
  handedTabView,
  type PopupActiveTab,
  type PopupMessageKey,
  popupView,
} from "./popup-view";

const activeTabs = [
  { kind: "stella" },
  { kind: "controllable" },
  { kind: "unsupported" },
] as const satisfies readonly PopupActiveTab[];
const controllers = [null, { origin: "https://app.stll.app" }] as const;
const grants = [false, true] as const;

describe("popupView", () => {
  for (const granted of grants) {
    for (const controller of controllers) {
      for (const activeTab of activeTabs) {
        test(`${granted ? "granted" : "not granted"}, ${controller ? "controller" : "no controller"}, ${activeTab.kind}`, () => {
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
      state: { origin: "https://example.com", type: "tab-handed-to-stella" },
      statusMessageKey: "statusTabHandedOver",
    });
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
        returnedMessageKeys.add(secondary.descriptionMessageKey);
      }
    }
  }
}
const handed = handedTabView("https://example.com");
returnedMessageKeys.add(handed.statusMessageKey);

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
