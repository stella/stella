import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/time" });

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { detectPlatform } = await import("@tanstack/react-hotkeys");
const { HOTKEYS } = await import("@/lib/hotkeys");
const { useQuickEntryStore } = await import("@/lib/time/quick-entry-store");
const { useQuickEntryHotkey } =
  await import("@/lib/time/use-quick-entry-hotkey");

afterEach(() => {
  cleanup();
  useQuickEntryStore.getState().closeDialog();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const pressLogTime = () => {
  const modifiers = {
    altKey: true,
    ctrlKey: detectPlatform() !== "mac",
    metaKey: detectPlatform() === "mac",
  };
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        ...modifiers,
        key: "t",
        code: "KeyT",
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        ...modifiers,
        key: "t",
        code: "KeyT",
        bubbles: true,
      }),
    );
  });
};

describe("global log-time shortcut", () => {
  test("opens the dialog in the current user and organization scope", () => {
    const scope = { userId: "user-a", organizationId: "organization-a" };
    const hook = renderHook(
      ({ scope: currentScope }) =>
        useQuickEntryHotkey({
          enabled: true,
          hotkey: HOTKEYS.LOG_TIME,
          scope: currentScope,
        }),
      { initialProps: { scope } },
    );

    pressLogTime();
    expect(useQuickEntryStore.getState().dialog).toEqual({
      status: "open",
      ...scope,
    });
    useQuickEntryStore.getState().closeDialog();

    const nextScope = { userId: "user-b", organizationId: "organization-b" };
    hook.rerender({ scope: nextScope });
    pressLogTime();
    expect(useQuickEntryStore.getState().dialog).toEqual({
      status: "open",
      ...nextScope,
    });
  });

  test("cannot open while disabled, including after an enabled registration", () => {
    const scope = { userId: "user-a", organizationId: "organization-a" };
    const hook = renderHook(
      ({ enabled }) =>
        useQuickEntryHotkey({
          enabled,
          hotkey: HOTKEYS.LOG_TIME,
          scope: currentScope,
        }),
      { initialProps: { enabled: false } },
    );

    pressLogTime();
    expect(useQuickEntryStore.getState().dialog).toEqual({ status: "closed" });
    hook.rerender({ enabled: true });
    pressLogTime();
    expect(useQuickEntryStore.getState().dialog).toEqual({
      status: "open",
      ...scope,
    });
    useQuickEntryStore.getState().closeDialog();
    hook.rerender({ enabled: false });
    pressLogTime();
    expect(useQuickEntryStore.getState().dialog).toEqual({ status: "closed" });
  });
});
