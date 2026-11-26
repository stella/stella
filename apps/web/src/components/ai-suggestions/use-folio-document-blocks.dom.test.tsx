import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { FolioAIBlock } from "@stll/folio-react";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { cleanup, renderHook, waitFor } = await import("@testing-library/react");
const { useFolioDocumentBlocks } =
  await import("@/components/ai-suggestions/use-folio-document-blocks");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

// The editor's read, told apart from the hook's own empty value by identity.
const blocks: FolioAIBlock[] = [];

const fakeEditorRef = () => {
  let snapshots = 0;
  const editor = {
    createAIEditSnapshot: () => {
      snapshots += 1;
      return { blocks };
    },
    ensureEditorView: () => undefined,
  };
  return { ref: { current: editor }, snapshots: () => snapshots };
};

test("blocks are read from the editor, and dropped in the render that disables the read", async () => {
  const editor = fakeEditorRef();
  const renders: (readonly FolioAIBlock[])[] = [];
  const { result, rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => {
      const value = useFolioDocumentBlocks(editor.ref, enabled);
      renders.push(value);
      return value;
    },
    { initialProps: { enabled: true } },
  );
  await waitFor(() => {
    expect(result.current).toBe(blocks);
  });

  renders.length = 0;
  rerender({ enabled: false });
  // No render after the switch shows the previous read.
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.some((value) => value === blocks)).toBe(false);

  const readsBefore = editor.snapshots();
  rerender({ enabled: true });
  expect(result.current).not.toBe(blocks);
  await waitFor(() => {
    expect(result.current).toBe(blocks);
  });
  expect(editor.snapshots()).toBe(readsBefore + 1);
});
