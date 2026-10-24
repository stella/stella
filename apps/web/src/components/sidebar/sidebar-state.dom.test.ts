import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, test } from "bun:test";

import { SIDEBAR_STATE_COOKIE } from "@/components/sidebar/sidebar-state-cookie";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const {
  readPersistedSidebarOpen,
  readSidebarStateAttribute,
  SIDEBAR_STATE_ATTRIBUTE,
  writePersistedSidebarOpen,
} = await import("./sidebar-state");

beforeEach(() => {
  document.documentElement.removeAttribute(SIDEBAR_STATE_ATTRIBUTE);
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("the browser reads the state the server wrote on the document", () => {
  expect(readPersistedSidebarOpen()).toBeNull();
  document.documentElement.setAttribute(SIDEBAR_STATE_ATTRIBUTE, "collapsed");
  expect(readSidebarStateAttribute()).toBe("collapsed");
  expect(readPersistedSidebarOpen()).toBe(false);
});

test("a toggle persists through the server when Cookie Store is unavailable", async () => {
  const cookieStore = Object.getOwnPropertyDescriptor(
    globalThis,
    "cookieStore",
  );
  Reflect.deleteProperty(globalThis, "cookieStore");
  try {
    const persisted: boolean[] = [];
    const firstStarted = Promise.withResolvers<undefined>();
    const releaseFirst = Promise.withResolvers<undefined>();
    const secondCompleted = Promise.withResolvers<undefined>();
    const persist = async ({ data }: { data: boolean }) => {
      persisted.push(data);
      if (data) {
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
      } else {
        secondCompleted.resolve(undefined);
      }
    };
    writePersistedSidebarOpen(true, persist);
    expect(readPersistedSidebarOpen()).toBe(true);
    writePersistedSidebarOpen(false, persist);
    expect(document.documentElement.getAttribute(SIDEBAR_STATE_ATTRIBUTE)).toBe(
      "collapsed",
    );
    expect(readPersistedSidebarOpen()).toBe(false);
    await firstStarted.promise;
    expect(persisted).toEqual([true]);
    releaseFirst.resolve(undefined);
    await secondCompleted.promise;
    expect(persisted).toEqual([true, false]);
  } finally {
    if (cookieStore === undefined) {
      Reflect.deleteProperty(globalThis, "cookieStore");
    } else {
      Object.defineProperty(globalThis, "cookieStore", cookieStore);
    }
  }
});

test("Cookie Store writes retain the latest toggle when an earlier write is slow", async () => {
  const cookieStore = Object.getOwnPropertyDescriptor(
    globalThis,
    "cookieStore",
  );
  const firstStarted = Promise.withResolvers<undefined>();
  const releaseFirst = Promise.withResolvers<undefined>();
  const secondCompleted = Promise.withResolvers<undefined>();
  const started: string[] = [];
  const completed: string[] = [];
  const cookies: CookieInit[] = [];
  Object.defineProperty(globalThis, "cookieStore", {
    configurable: true,
    value: {
      set: async (cookie: CookieInit) => {
        cookies.push(cookie);
        started.push(cookie.value);
        if (cookie.value === "expanded") {
          firstStarted.resolve(undefined);
          await releaseFirst.promise;
        }
        completed.push(cookie.value);
        if (cookie.value === "collapsed") {
          secondCompleted.resolve(undefined);
        }
      },
    },
  });
  try {
    writePersistedSidebarOpen(true);
    writePersistedSidebarOpen(false);
    expect(readPersistedSidebarOpen()).toBe(false);
    await firstStarted.promise;
    expect(started).toEqual(["expanded"]);
    expect(completed).toEqual([]);
    releaseFirst.resolve(undefined);
    await secondCompleted.promise;
    expect(started).toEqual(["expanded", "collapsed"]);
    expect(completed).toEqual(["expanded", "collapsed"]);
    for (const cookie of cookies) {
      expect(cookie).toMatchObject({
        name: SIDEBAR_STATE_COOKIE,
        path: "/",
        sameSite: "lax",
      });
      expect(cookie.expires).toBeGreaterThan(Date.now());
    }
  } finally {
    releaseFirst.resolve(undefined);
    if (cookieStore === undefined) {
      Reflect.deleteProperty(globalThis, "cookieStore");
    } else {
      Object.defineProperty(globalThis, "cookieStore", cookieStore);
    }
  }
});
