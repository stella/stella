import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/storage" });
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { browserStorage } = await import("./browser-storage");
const { USER_STORAGE_FAMILIES } = await import("./storage-families");
const { useUserStorageState } = await import("./use-user-storage-state");
const { installUserScopedStorage } =
  await import("./install-user-scoped-storage");
const { releaseUserStorage, userStorageKey } =
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
