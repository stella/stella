import { afterEach, describe, expect, test } from "bun:test";

import {
  type BrowserController,
  browserControllerMatchesSender,
  controllerForSender,
  disconnectBrowserController,
  endControllerAfterTabClosed,
  pairStellaTab,
  readBrowserController,
} from "./controller";
import {
  forgetStellaTab,
  readStellaTabs,
  rememberStellaTab,
  replaceStellaTab,
} from "./stella-tabs";
import { CONTROLLED_TAB_RULE_IDS } from "./tab-containment";

const STELLA_ORIGIN = "https://my.stll.app";
const OTHER_STELLA_ORIGIN = "https://app.stll.app";

const controller = {
  controllerId: "controller-1",
  origin: STELLA_ORIGIN,
} satisfies BrowserController;

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

type SentMessage = {
  controllerId: unknown;
  documentId: string | null;
  tabId: number;
};

/** A browser session with real storage semantics and recorded tab messages. */
const installFakeChrome = (urls: Record<number, string> = {}) => {
  const session: Record<string, unknown> = {};
  const sent: SentMessage[] = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      declarativeNetRequest: { updateSessionRules: async () => undefined },
      permissions: { contains: async () => true },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          remove: async (keys: string | string[]) => {
            for (const key of [keys].flat()) {
              Reflect.deleteProperty(session, key);
            }
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(session, structuredClone(items));
          },
        },
      },
      tabs: {
        get: async (tabId: number) => ({ id: tabId, url: urls[tabId] }),
        sendMessage: async (
          tabId: number,
          message: { controllerId: unknown },
          options?: { documentId?: string },
        ) => {
          sent.push({
            controllerId: message.controllerId,
            documentId: options?.documentId ?? null,
            tabId,
          });
        },
      },
    },
  });
  return { sent, session };
};

describe("browser controller connection", () => {
  test("covers every tab on its exact origin and no other origin", () => {
    expect(
      browserControllerMatchesSender(controller, `${STELLA_ORIGIN}/chat`),
    ).toBe(true);
    expect(
      browserControllerMatchesSender(controller, `${STELLA_ORIGIN}/matters/7`),
    ).toBe(true);
    expect(
      browserControllerMatchesSender(controller, `${OTHER_STELLA_ORIGIN}/chat`),
    ).toBe(false);
    expect(
      browserControllerMatchesSender(controller, "https://example.com/chat"),
    ).toBe(false);
  });

  test("a second stella tab on the origin is connected without pairing again", async () => {
    const { sent } = installFakeChrome({
      1: `${STELLA_ORIGIN}/chat`,
    });
    await rememberStellaTab(2, { documentId: "doc-2", origin: STELLA_ORIGIN });
    await rememberStellaTab(3, {
      documentId: "doc-3",
      origin: OTHER_STELLA_ORIGIN,
    });

    const paired = await pairStellaTab(1);
    if (paired.status !== "paired") {
      throw new TypeError("The stella tab did not pair");
    }
    const { controllerId } = paired.controller;

    expect(await controllerForSender(`${STELLA_ORIGIN}/matters`)).toEqual({
      controllerId,
      origin: STELLA_ORIGIN,
    });
    expect(await controllerForSender(`${OTHER_STELLA_ORIGIN}/chat`)).toBeNull();
    // Both tabs on the origin hear about the connection, each at the
    // document it messaged from; the other origin's tab hears nothing.
    expect(sent.toSorted((left, right) => left.tabId - right.tabId)).toEqual([
      { controllerId, documentId: null, tabId: 1 },
      { controllerId, documentId: "doc-2", tabId: 2 },
    ]);
  });

  test("pairing on another origin ends the first origin's connection", async () => {
    const { sent } = installFakeChrome({
      1: `${STELLA_ORIGIN}/chat`,
      3: `${OTHER_STELLA_ORIGIN}/chat`,
    });
    await rememberStellaTab(1, { documentId: "doc-1", origin: STELLA_ORIGIN });
    await rememberStellaTab(3, {
      documentId: "doc-3",
      origin: OTHER_STELLA_ORIGIN,
    });
    await pairStellaTab(1);
    sent.length = 0;

    const paired = await pairStellaTab(3);
    if (paired.status !== "paired") {
      throw new TypeError("The stella tab did not pair");
    }
    expect(await controllerForSender(`${STELLA_ORIGIN}/chat`)).toBeNull();
    expect(sent).toEqual([
      { controllerId: null, documentId: "doc-1", tabId: 1 },
      {
        controllerId: paired.controller.controllerId,
        documentId: "doc-3",
        tabId: 3,
      },
    ]);
  });

  test("ends only when the last stella tab on its origin closes", async () => {
    installFakeChrome({ 1: `${STELLA_ORIGIN}/chat` });
    await rememberStellaTab(1, { documentId: "doc-1", origin: STELLA_ORIGIN });
    await rememberStellaTab(2, { documentId: "doc-2", origin: STELLA_ORIGIN });
    await rememberStellaTab(3, {
      documentId: "doc-3",
      origin: OTHER_STELLA_ORIGIN,
    });
    await pairStellaTab(1);

    expect(await endControllerAfterTabClosed(await forgetStellaTab(3))).toBe(
      false,
    );
    expect(await endControllerAfterTabClosed(await forgetStellaTab(1))).toBe(
      false,
    );
    expect(await readBrowserController()).not.toBeNull();
    expect(await endControllerAfterTabClosed(await forgetStellaTab(2))).toBe(
      true,
    );
    expect(await readBrowserController()).toBeNull();
  });

  test("deletes controller data, receipts and the tab rules on disconnect", async () => {
    const removedKeys: unknown[] = [];
    const removedRuleIds: unknown[] = [];
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        declarativeNetRequest: {
          updateSessionRules: async (options: { removeRuleIds?: number[] }) => {
            removedRuleIds.push(options.removeRuleIds);
          },
        },
        storage: {
          session: {
            get: async () => ({
              browserController: null,
            }),
            remove: async (keys: unknown) => {
              removedKeys.push(keys);
            },
          },
        },
      },
    });

    await disconnectBrowserController();
    expect(removedKeys).toEqual([
      [
        "browserController",
        "browserControlledTab",
        "browserExecutionReceipts",
        "browserCommandBudget",
      ],
      "browserContainedTabs",
    ]);
    expect(removedRuleIds).toEqual([CONTROLLED_TAB_RULE_IDS]);
  });
});

describe("stella tab registry", () => {
  test("keeps a tab's document when the popup registers it again", async () => {
    installFakeChrome();
    await rememberStellaTab(1, { documentId: "doc-1", origin: STELLA_ORIGIN });
    await rememberStellaTab(1, { documentId: null, origin: STELLA_ORIGIN });
    expect((await readStellaTabs()).get(1)).toEqual({
      documentId: "doc-1",
      origin: STELLA_ORIGIN,
    });
  });

  test("records concurrent messages from several tabs", async () => {
    installFakeChrome();
    await Promise.all(
      [1, 2, 3, 4].map(
        async (tabId) =>
          await rememberStellaTab(tabId, {
            documentId: `doc-${tabId}`,
            origin: STELLA_ORIGIN,
          }),
      ),
    );
    expect([...(await readStellaTabs()).keys()].toSorted()).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("moves a tab Chrome swapped for another", async () => {
    installFakeChrome();
    await rememberStellaTab(42, {
      documentId: "doc-42",
      origin: STELLA_ORIGIN,
    });
    await replaceStellaTab(43, 42);
    await replaceStellaTab(44, 99);
    const tabs = await readStellaTabs();
    expect([...tabs.keys()]).toEqual([43]);
  });
});
