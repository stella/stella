import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, jest, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useDocxCheckpointAutosave } =
  await import("./use-docx-checkpoint-autosave");

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
afterAll(unregisterDomEnvironment);

test("a settled edit checkpoints without requestIdleCallback", async () => {
  jest.useFakeTimers();
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: undefined,
  });
  try {
    const buffer = new ArrayBuffer(4);
    const save = mock(async () => buffer);
    const saveCheckpoint = mock(async () => "saved" as const);
    const setAutosaveStatus = mock(() => {});
    const hasSessionChangesRef = { current: false };
    const { result } = renderHook(() =>
      useDocxCheckpointAutosave({
        editorRef: { current: { save } },
        hasSessionChangesRef,
        isCollaborativeEditing: false,
        isUnlocked: true,
        markDirty: mock(() => {}),
        saveCheckpoint,
        setAutosaveStatus,
        timingSurface: "fullView",
      }),
    );
    act(() => result.current.handleChange());
    expect(hasSessionChangesRef.current).toBe(true);
    await act(async () => jest.advanceTimersByTime(2000));
    expect(saveCheckpoint).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(2000));
    expect(save).toHaveBeenCalledWith({ selective: true });
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(saveCheckpoint).toHaveBeenCalledWith(buffer);
    expect(setAutosaveStatus).toHaveBeenLastCalledWith("synced");
  } finally {
    if (descriptor) {
      Object.defineProperty(window, "requestIdleCallback", descriptor);
    } else {
      Reflect.deleteProperty(window, "requestIdleCallback");
    }
  }
});
