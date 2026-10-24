import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const {
  readPersistedSidebarOpen,
  readSidebarStateAttribute,
  SIDEBAR_STATE_ATTRIBUTE,
  writePersistedSidebarOpen,
} = await import("./sidebar-state");

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
  const persisted: boolean[] = [];
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondCompleted = Promise.withResolvers<void>();
  const persist = async ({ data }: { data: boolean }) => {
    persisted.push(data);
    if (data) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      secondCompleted.resolve();
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
  releaseFirst.resolve();
  await secondCompleted.promise;
  expect(persisted).toEqual([true, false]);
});
