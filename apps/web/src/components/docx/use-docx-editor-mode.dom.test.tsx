import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useDocxEditorMode } =
  await import("@/components/docx/use-docx-editor-mode");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("the picked mode holds while the lock stays, and starts over as editing when it changes", () => {
  const renders: string[] = [];
  const { result, rerender } = renderHook(
    ({ isUnlocked }: { isUnlocked: boolean }) => {
      const mode = useDocxEditorMode(isUnlocked);
      renders.push(mode.editorMode);
      return mode;
    },
    { initialProps: { isUnlocked: true } },
  );

  act(() => {
    result.current.handleEditorModeChange("suggesting");
  });
  rerender({ isUnlocked: true });
  expect(result.current.editorMode).toBe("suggesting");

  // Folio's own viewing mode is never kept.
  act(() => {
    result.current.handleEditorModeChange("viewing");
  });
  expect(result.current.editorMode).toBe("suggesting");

  renders.length = 0;
  rerender({ isUnlocked: false });
  // The reset lands in the render that sees the lock: the stale mode is
  // never rendered.
  expect(renders.length).toBeGreaterThan(0);
  expect(new Set(renders)).toEqual(new Set(["editing"]));

  rerender({ isUnlocked: true });
  expect(result.current.editorMode).toBe("editing");
});
