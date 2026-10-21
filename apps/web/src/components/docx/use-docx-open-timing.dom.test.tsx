import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DocxEditorRef } from "@stll/folio-react";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { cleanup, renderHook } = await import("@testing-library/react");
const React = await import("react");
const { useDocxOpenTiming } = await import("./use-docx-open-timing");

afterEach(cleanup);

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("mounting the editor eagerly creates its view without taking focus", () => {
  const calls: { focus: boolean }[] = [];
  const editorRef =
    React.createRef<
      Pick<DocxEditorRef, "ensureEditorView" | "onLayoutChange">
    >();
  const editor = {
    ensureEditorView: (options?: { focus?: boolean }) => {
      calls.push({ focus: options?.focus ?? true });
    },
    onLayoutChange: () => () => {},
  };
  const { result } = renderHook(() =>
    useDocxOpenTiming({ editorRef, fieldId: "field-1", surface: "fullView" }),
  );

  result.current(editor);

  expect(editorRef.current).toBe(editor);
  expect(calls).toEqual([{ focus: false }]);
});
