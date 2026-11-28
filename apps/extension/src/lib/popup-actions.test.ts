import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { type PopupTab, runPopupAction } from "./popup-actions";

const currentTab = { id: 2, url: "https://example.com/" } satisfies PopupTab;

const createDependencies = () => {
  const calls: string[] = [];
  const connectedTabs: (number | null)[] = [];
  const adoptedTabs: (PopupTab | null)[] = [];
  const access = Promise.withResolvers<boolean>();
  const deps = {
    requestAccess: async () => {
      calls.push("requestAccess");
      return access.promise;
    },
    readActiveTab: async () => {
      calls.push("readActiveTab");
      return currentTab;
    },
    connectWebsite: async (tabId: number | null) => {
      calls.push("connectWebsite");
      connectedTabs.push(tabId);
    },
    adopt: async (tab: PopupTab | null) => {
      calls.push("adopt");
      adoptedTabs.push(tab);
    },
    disconnect: async () => {
      calls.push("disconnect");
    },
    revoke: async () => {
      calls.push("revoke");
    },
    render: async () => {
      calls.push("render");
    },
  } satisfies Parameters<typeof runPopupAction>[1];
  return { access, adoptedTabs, calls, connectedTabs, deps };
};

for (const tabId of [1, null]) {
  for (const granted of [true, false]) {
    test(`Connect ${tabId === null ? "elsewhere" : "on a stella tab"} asks for access within the click before anything else, then handles ${granted ? "approval" : "denial"}`, async () => {
      const { access, calls, connectedTabs, deps } = createDependencies();
      const completion = runPopupAction(
        { action: "connect-website", askAccess: true, tabId },
        deps,
      );
      // No await: permission prompts must start before the click yields.
      expect(calls).toEqual(["requestAccess"]);
      await Promise.resolve();
      expect(calls).toEqual(["requestAccess"]);

      access.resolve(granted);
      await completion;
      if (granted) {
        expect(calls).toEqual(["requestAccess", "connectWebsite"]);
        expect(connectedTabs).toEqual([tabId]);
      } else {
        expect(calls).toEqual(["requestAccess", "render"]);
        expect(connectedTabs).toEqual([]);
      }
    });
  }
}

test("Connect with access already granted connects without asking", async () => {
  const { calls, connectedTabs, deps } = createDependencies();
  await runPopupAction(
    { action: "connect-website", askAccess: false, tabId: null },
    deps,
  );
  expect(calls).toEqual(["connectWebsite"]);
  expect(connectedTabs).toEqual([null]);
});

test("adopt uses the current active tab", async () => {
  const { adoptedTabs, calls, deps } = createDependencies();
  await runPopupAction({ action: "adopt" }, deps);
  expect(calls).toEqual(["readActiveTab", "adopt"]);
  expect(adoptedTabs).toEqual([currentTab]);
});

for (const action of ["disconnect", "revoke"] as const) {
  test(`${action} refreshes the popup after completing`, async () => {
    const { calls, deps } = createDependencies();
    const operation = Promise.withResolvers<undefined>();
    deps[action] = async () => {
      calls.push(action);
      return operation.promise;
    };
    const completion = runPopupAction({ action }, deps);
    expect(calls).toEqual([action]);
    operation.resolve(undefined);
    await completion;
    expect(calls).toEqual([action, "render"]);
  });
}

test("a rejected permission request propagates without connecting", async () => {
  const { access, calls, connectedTabs, deps } = createDependencies();
  const completion = runPopupAction(
    { action: "connect-website", askAccess: true, tabId: 1 },
    deps,
  );
  const failure = { message: "Permission request failed" };
  access.reject(failure);
  expect(await rejectionOf(completion)).toBe(failure);
  expect(calls).toEqual(["requestAccess"]);
  expect(connectedTabs).toEqual([]);
});
