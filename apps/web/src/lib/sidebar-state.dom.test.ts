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

test("a toggle is what the next read sees", () => {
  writePersistedSidebarOpen(true);
  expect(readPersistedSidebarOpen()).toBe(true);
  writePersistedSidebarOpen(false);
  expect(document.documentElement.getAttribute(SIDEBAR_STATE_ATTRIBUTE)).toBe(
    "collapsed",
  );
  expect(readPersistedSidebarOpen()).toBe(false);
});
