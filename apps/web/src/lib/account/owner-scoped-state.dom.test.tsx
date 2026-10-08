import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/storage" });
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { browserStorage, browserStateStorage, deviceStorage } =
  await import("./browser-storage");
const { USER_STORAGE_FAMILIES, DEVICE_STORAGE_FAMILIES } =
  await import("./storage-families");
const { useUserStorageState } = await import("./use-user-storage-state");
const { rootKeys } = await import("@/lib/auth-queries");
const { installUserScopedStorage } =
  await import("./install-user-scoped-storage");
const { releaseUserStorage, userStorageKey, userScopedStateStorage } =
  await import("./user-scoped-storage");
const { useColumnWidths } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/filesystem/use-column-widths");
const decode = (value: string | null) => value ?? "empty";
const encode = (value: string) => value;
const areas = () => ({ local: null, session: null });
afterEach(() => {
  cleanup();
  releaseUserStorage(areas());
  browserStorage("local")?.clear();
  browserStorage("session")?.clear();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const family of USER_STORAGE_FAMILIES.filter(
  ({ owner }) => owner === "scoped",
)) {
  test(`mounted ${family.prefix} state follows every owner transition`, () => {
    const client = new QueryClient();
    const unsubscribe = installUserScopedStorage(client, areas);
    const area =
      browserStorage(family.area) ?? panic("Test requires browser storage");
    const baseKey = `${family.prefix}transition`;
    const keyA = userStorageKey(baseKey, { kind: "user", userId: "a" });
    const keyB = userStorageKey(baseKey, { kind: "user", userId: "b" });
    area.setItem(keyA, "A");
    area.setItem(keyB, "B");
    client.setQueryData(["session"], { user: { id: "a" } });
    const mounted = renderHook(() =>
      useUserStorageState({ baseKey, area: family.area, decode, encode }),
    );
    expect(mounted.result.current.value).toBe("A");
    const stale = mounted.result.current.setValue;
    act(() => {
      client.setQueryData(["session"], null);
    });
    expect(mounted.result.current.value).toBe("empty");
    const staleVisitor = mounted.result.current.setValue;
    act(() => {
      client.setQueryData(["session"], { user: { id: "b" } });
    });
    expect(mounted.result.current.value).toBe("B");
    act(() => {
      stale("stale");
      mounted.result.current.setValue("B resized");
    });
    expect(area.getItem(keyA)).toBe("A");
    expect(area.getItem(keyB)).toBe("B resized");
    act(() => {
      client.setQueryData(["session"], { user: { id: "a" } });
      stale("stale again");
    });
    expect(mounted.result.current.value).toBe("A");
    expect(area.getItem(keyA)).toBe("A");
    act(() => {
      client.setQueryData(["session"], null);
      staleVisitor("stale visitor");
    });
    expect(mounted.result.current.value).toBe("empty");
    mounted.unmount();
    unsubscribe();
    client.clear();
  });
}

test("mounted tree restores saved widths and resizes within the active owner", () => {
  const client = new QueryClient();
  const unsubscribe = installUserScopedStorage(client, areas);
  const area =
    browserStorage("local") ?? panic("Test requires browser storage");
  const baseKey = "stella.tree-view.column-widths.tree";
  const keyA = userStorageKey(baseKey, { kind: "user", userId: "a" });
  const keyB = userStorageKey(baseKey, { kind: "user", userId: "b" });
  area.setItem(keyA, '{"name":100}');
  area.setItem(keyB, '{"name":300,"date":200}');
  client.setQueryData(["session"], { user: { id: "a" } });
  const mounted = renderHook(() => useColumnWidths(baseKey));
  act(() => {
    mounted.result.current.setWidth("name", 150);
  });
  expect(mounted.result.current.widths).toEqual({ name: 150 });
  const staleResize = mounted.result.current.setWidth;
  act(() => {
    client.setQueryData(["session"], { user: { id: "b" } });
  });
  expect(mounted.result.current.widths).toEqual({ name: 300, date: 200 });
  act(() => {
    staleResize("name", 700);
    mounted.result.current.setWidth("name", 350);
  });
  expect(mounted.result.current.widths).toEqual({ name: 350, date: 200 });
  expect(area.getItem(keyA)).toBe('{"name":150}');
  expect(area.getItem(keyB)).toBe('{"name":350,"date":200}');
  mounted.unmount();
  unsubscribe();
  client.clear();
});

type StorageFamily = (typeof USER_STORAGE_FAMILIES)[number];
const familyEntry = (family: StorageFamily) => {
  const baseKey = `${family.prefix}document:anchor`;
  const area = browserStateStorage(family.area);
  const { owner } = family;
  switch (owner) {
    case "scoped":
      return {
        family,
        baseKey,
        key: userStorageKey(baseKey),
        storage: userScopedStateStorage(area),
      };
    case "carried":
      return { family, baseKey, key: baseKey, storage: area };
    default:
      owner satisfies never;
      return panic("Unhandled registered storage ownership");
  }
};

const storageAreas = [
  ...new Set(
    [...USER_STORAGE_FAMILIES, ...DEVICE_STORAGE_FAMILIES].map(
      ({ area }) => area,
    ),
  ),
];

const rawKeys = (area: StorageFamily["area"]) => {
  const storage =
    browserStorage(area) ?? panic("Test requires browser storage");
  return Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null);
};

/** Only device entries and what is kept for user "a" remain. */
const assertOnlyDeviceAndKeptEntries = () => {
  for (const area of storageAreas) {
    for (const key of rawKeys(area)) {
      expect(
        DEVICE_STORAGE_FAMILIES.some(
          (family) => family.area === area && key.startsWith(family.prefix),
        ) ||
          USER_STORAGE_FAMILIES.some(
            (family) =>
              family.area === area &&
              family.retention === "kept-for-owner" &&
              key.startsWith(family.prefix) &&
              key.endsWith(":u:a"),
          ),
      ).toBe(true);
    }
  }
};

type SessionTransition = "account switch" | "sign-out";
const assertRegisteredSessionTransition = (transition: SessionTransition) => {
  const client = new QueryClient();
  const unsubscribe = installUserScopedStorage(client);
  client.setQueryData(rootKeys.session, { user: { id: "a" } });
  const entries = USER_STORAGE_FAMILIES.map(familyEntry);
  const devices = DEVICE_STORAGE_FAMILIES.map((family) => ({
    ...family,
    // Child keys let the canonical session-owner marker record transitions.
    key: `${family.prefix}registry-fixture`,
  }));
  try {
    for (const entry of entries) {
      entry.storage.setItem(entry.baseKey, "A");
      expect(entry.storage.getItem(entry.baseKey)).toBe("A");
      expect(browserStorage(entry.family.area)?.getItem(entry.key)).toBe("A");
    }
    for (const device of devices) {
      deviceStorage(device.area).setItem(device.key, "device");
      expect(deviceStorage(device.area).getItem(device.key)).toBe("device");
    }
    const scoped =
      entries.find(({ family }) => family.owner === "scoped") ??
      panic("Test requires a scoped family");
    const mounted = renderHook(() =>
      useUserStorageState({
        baseKey: scoped.baseKey,
        area: scoped.family.area,
        decode,
        encode,
      }),
    );
    expect(mounted.result.current.value).toBe("A");
    if (transition === "sign-out") {
      act(() => {
        releaseUserStorage();
      });
      expect(mounted.result.current.value).toBe("empty");
      assertOnlyDeviceAndKeptEntries();
      for (const entry of entries) {
        expect(entry.storage.getItem(entry.baseKey)).toBeNull();
      }
    }
    act(() => {
      client.setQueryData(rootKeys.session, { user: { id: "b" } });
    });
    expect(mounted.result.current.value).toBe("empty");
    for (const entry of entries) {
      // User "b" never reads user "a"'s entries.
      expect(entry.storage.getItem(entry.baseKey)).toBeNull();
      // What is kept for "a" waits under their key; the rest (carried
      // entries too) goes when they leave.
      expect(rawKeys(entry.family.area).includes(entry.key)).toBe(
        entry.family.retention === "kept-for-owner",
      );
    }
    assertOnlyDeviceAndKeptEntries();
    for (const device of devices) {
      expect(deviceStorage(device.area).getItem(device.key)).toBe("device");
    }
    mounted.unmount();
  } finally {
    cleanup();
    unsubscribe();
    releaseUserStorage();
    client.clear();
  }
};

test("registered storage families follow an account switch", () => {
  assertRegisteredSessionTransition("account switch");
});

test("registered storage families follow sign-out and account sign-in", () => {
  assertRegisteredSessionTransition("sign-out");
});
