import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { type PopupTab, runPopupAction } from "./popup-actions";
import { popupView } from "./popup-view";

const renderedTab = {
  id: 1,
  url: "https://app.stll.app",
} satisfies PopupTab;
const currentTab = { ...renderedTab, id: 2 };

const createDependencies = () => {
  const calls: string[] = [];
  const pairedTabs: (PopupTab | null)[] = [];
  const adoptedTabs: (PopupTab | null)[] = [];
  const access = Promise.withResolvers<boolean>();
  const deps = {
    renderedTab,
    requestAccess: async () => {
      calls.push("requestAccess");
      return access.promise;
    },
    readActiveTab: async () => {
      calls.push("readActiveTab");
      return currentTab;
    },
    pair: async (tab: PopupTab | null) => {
      calls.push("pair");
      pairedTabs.push(tab);
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
  return { access, adoptedTabs, calls, deps, pairedTabs };
};

for (const action of ["grant", "grant-and-connect"] as const) {
  for (const granted of [true, false]) {
    test(`${action} requests access within the click before any other dependency, then handles ${granted ? "approval" : "denial"}`, async () => {
      const { access, calls, deps, pairedTabs } = createDependencies();
      const view = popupView({
        activeTab:
          action === "grant-and-connect"
            ? { kind: "stella", tabId: renderedTab.id }
            : { kind: "controllable" },
        controller: null,
        granted: false,
      });
      expect(view.primary?.action).toBe(action);

      const completion = runPopupAction(action, deps);
      // No await: permission prompts must start before the click yields.
      expect(calls).toEqual(["requestAccess"]);
      await Promise.resolve();
      expect(calls).toEqual(["requestAccess"]);
      expect(pairedTabs).toEqual([]);

      access.resolve(granted);
      await completion;
      if (!granted) {
        expect(calls).toEqual(["requestAccess", "render"]);
        expect(pairedTabs).toEqual([]);
      } else if (action === "grant-and-connect") {
        expect(calls).toEqual(["requestAccess", "pair"]);
        expect(pairedTabs).toHaveLength(1);
        expect(pairedTabs.at(0)).toBe(renderedTab);
        expect(pairedTabs.at(0)).not.toBe(currentTab);
      } else {
        expect(calls).toEqual(["requestAccess", "render"]);
        expect(pairedTabs).toEqual([]);
      }
    });
  }
}

for (const action of ["connect", "adopt"] as const) {
  test(`${action} uses the current active tab`, async () => {
    const { adoptedTabs, calls, deps, pairedTabs } = createDependencies();
    await runPopupAction(action, deps);
    expect(calls).toEqual([
      "readActiveTab",
      action === "connect" ? "pair" : "adopt",
    ]);
    expect(pairedTabs).toEqual(action === "connect" ? [currentTab] : []);
    expect(adoptedTabs).toEqual(action === "adopt" ? [currentTab] : []);
  });
}

for (const action of ["disconnect", "revoke"] as const) {
  test(`${action} refreshes the popup after completing`, async () => {
    const { calls, deps } = createDependencies();
    const operation = Promise.withResolvers<undefined>();
    deps[action] = async () => {
      calls.push(action);
      return operation.promise;
    };
    const completion = runPopupAction(action, deps);
    expect(calls).toEqual([action]);
    operation.resolve(undefined);
    await completion;
    expect(calls).toEqual([action, "render"]);
  });
}

test("a rejected permission request propagates without pairing or rendering success", async () => {
  const { access, calls, deps, pairedTabs } = createDependencies();
  const completion = runPopupAction("grant-and-connect", deps);
  const failure = { message: "Permission request failed" };
  access.reject(failure);
  expect(await rejectionOf(completion)).toBe(failure);
  expect(calls).toEqual(["requestAccess"]);
  expect(pairedTabs).toEqual([]);
});
