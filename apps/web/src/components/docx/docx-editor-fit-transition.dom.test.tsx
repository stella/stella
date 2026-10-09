import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DocxEditorProps, DocxEditorRef } from "./app-docx-editor";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const React = await import("react");
const { IntlProvider } = await import("use-intl");
const { createEmptyDocument } = await import("@stll/folio-react");
const { DocxEditor } = await import("./app-docx-editor");
const { releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");
const { bundledEnglishMessages } = await import("@/i18n/i18n-store");

class ResizeObserverProbe implements ResizeObserver {
  static instances = new Set<ResizeObserverProbe>();
  readonly observed = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverProbe.instances.add(this);
  }

  observe(target: Element, _options?: ResizeObserverOptions) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
    ResizeObserverProbe.instances.delete(this);
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  emit(target: Element) {
    if (this.observed.has(target)) {
      this.callback([], this);
    }
  }
}

afterEach(() => {
  cleanup();
  releaseUserStorage();
  ResizeObserverProbe.instances.clear();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("numeric zoom transitions to fit-width and refits when the editor viewport shrinks", async () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverProbe,
  });

  try {
    const editorRef = React.createRef<DocxEditorRef>();
    const document = createEmptyDocument({
      initialText: "Fit transition sample.",
    });
    const Harness = ({
      initialZoom,
    }: Required<Pick<DocxEditorProps, "initialZoom">>) => (
      <IntlProvider
        locale="en"
        messages={bundledEnglishMessages}
        timeZone="UTC"
      >
        <DocxEditor
          document={document}
          initialZoom={initialZoom}
          ref={editorRef}
          showOutline={false}
          showToolbar={false}
        />
      </IntlProvider>
    );

    const mounted = render(<Harness initialZoom={0.8} />);
    await waitFor(() => expect(editorRef.current).not.toBeNull());
    const editor = editorRef.current;
    if (!editor) {
      throw new Error("Published editor ref did not mount");
    }
    await act(async () => {
      editor.ensureEditorView({ focus: false });
    });
    await waitFor(() => {
      const layout = editor.getEditorRef()?.getLayout();
      expect(layout?.pages.at(0)?.size.w).toBeGreaterThan(0);
      expect(editor.getEditorRef()?.getScrollRoot()).not.toBeNull();
    });

    const scrollRoot = editor.getEditorRef()?.getScrollRoot();
    const layout = editor.getEditorRef()?.getLayout();
    const pageWidth = layout?.pages.at(0)?.size.w;
    if (!scrollRoot || !pageWidth) {
      throw new Error("Published editor layout or scroll root is unavailable");
    }

    let viewportWidth = 920;
    Object.defineProperty(scrollRoot, "clientWidth", {
      configurable: true,
      get: () => viewportWidth,
    });

    await act(async () => {
      mounted.rerender(<Harness initialZoom="fit-width" />);
    });
    expect(editorRef.current).toBe(editor);
    const fitObservers = await waitFor(() => {
      const observers = [...ResizeObserverProbe.instances].filter((instance) =>
        instance.observed.has(scrollRoot),
      );
      expect(observers.length).toBeGreaterThan(0);
      return observers;
    });

    await waitFor(() => {
      expect(editor.getZoom()).toBeGreaterThan(0.8);
      expect(pageWidth * editor.getZoom()).toBeLessThanOrEqual(viewportWidth);
    });

    viewportWidth = 420;
    await act(async () => {
      for (const observer of fitObservers) {
        observer.emit(scrollRoot);
      }
    });
    await waitFor(() => {
      expect(editor.getZoom()).toBeLessThan(0.8);
      expect(pageWidth * editor.getZoom()).toBeLessThanOrEqual(viewportWidth);
    });
  } finally {
    cleanup();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalResizeObserver,
    });
  }
});
