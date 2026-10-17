import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { defaultPresentationPrefs } from "./preferences";
import type { PresentationPrefs } from "./preferences";
import { createPresentationPrefsSync } from "./sync";
import {
  createPrefsBroadcastHub,
  createPrefsWriteLock,
} from "./sync.test-fixtures";

test("overlapping theme and sidebar saves from two tabs both survive reload", async () => {
  let cookie = defaultPresentationPrefs;
  const withLock = createPrefsWriteLock();
  const hub = createPrefsBroadcastHub();
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const requests: Partial<PresentationPrefs>[] = [];
  const write = async (patch: Partial<PresentationPrefs>) => {
    const incomingCookie = cookie;
    requests.push(patch);
    if (patch.theme !== undefined) {
      started.resolve(undefined);
      await release.promise;
    }
    cookie = { ...incomingCookie, ...patch };
    return cookie;
  };
  const first = createPresentationPrefsSync({
    initialPrefs: cookie,
    read: async () => await Promise.resolve(cookie),
    write,
    withLock,
    openChannel: hub.open,
  });
  const second = createPresentationPrefsSync({
    initialPrefs: cookie,
    read: async () => await Promise.resolve(cookie),
    write,
    withLock,
    openChannel: hub.open,
  });
  const stopFirst = first.subscribeToPeers();
  const stopSecond = second.subscribeToPeers();
  try {
    const themeSave = first.update(() => ({ theme: "dark" }));
    await started.promise;
    const sidebarSave = second.update(() => ({ sidebarOpen: false }));
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([{ theme: "dark" }]);
    release.resolve(undefined);
    await themeSave;
    // Receiving another tab's saved state retains the pending local change.
    expect(second.getSnapshot()).toMatchObject({
      theme: "dark",
      sidebarOpen: false,
    });
    await sidebarSave;
    expect(requests).toEqual([{ theme: "dark" }, { sidebarOpen: false }]);
    expect(first.getSnapshot()).toMatchObject({
      theme: "dark",
      sidebarOpen: false,
    });
    expect(second.getSnapshot()).toMatchObject({
      theme: "dark",
      sidebarOpen: false,
    });
    const reloaded = createPresentationPrefsSync({
      initialPrefs: cookie,
      read: async () => await Promise.resolve(cookie),
      write,
    });
    expect(reloaded.getSnapshot()).toMatchObject({
      theme: "dark",
      sidebarOpen: false,
    });
  } finally {
    release.resolve(undefined);
    stopFirst();
    stopSecond();
  }
  expect(hub.connected()).toBe(0);
});

test("without browser coordination APIs one tab still serializes writes and broadcasts no unsaved prefs", async () => {
  let cookie = defaultPresentationPrefs;
  const sync = createPresentationPrefsSync({
    initialPrefs: cookie,
    read: async () => await Promise.resolve(cookie),
    write: async (patch) => {
      const incomingCookie = cookie;
      await Promise.resolve();
      cookie = { ...incomingCookie, ...patch };
      return cookie;
    },
  });
  const saves = [
    sync.update(() => ({ theme: "dark" })),
    sync.update(() => ({ sidebarOpen: false })),
  ];
  expect(sync.getSnapshot()).toMatchObject({
    theme: "dark",
    sidebarOpen: false,
  });
  await Promise.all(saves);
  expect(cookie).toMatchObject({ theme: "dark", sidebarOpen: false });
  expect(sync.getSnapshot()).toEqual(cookie);
});

test("a failed save rejects its caller and later changes still persist", async () => {
  let cookie = defaultPresentationPrefs;
  const sync = createPresentationPrefsSync({
    initialPrefs: cookie,
    read: async () => await Promise.resolve(cookie),
    write: async (patch) => {
      if (patch.theme !== undefined) {
        throw new Error("Preference save failed");
      }
      cookie = { ...cookie, ...patch };
      return cookie;
    },
  });
  const failed = sync.update(() => ({ theme: "dark" }));
  const saved = sync.update(() => ({ sidebarOpen: false }));
  expect(await rejectionOf(failed)).toMatchObject({
    message: "Preference save failed",
  });
  await saved;
  expect(sync.getSnapshot()).toMatchObject({
    theme: "system",
    sidebarOpen: false,
  });
});
