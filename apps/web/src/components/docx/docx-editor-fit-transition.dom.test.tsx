import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DocxEditorProps, DocxEditorRef } from "./app-docx-editor";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const React = await import("react");
const { IntlProvider } = await import("use-intl");
const { createEmptyDocument } = await import("@stll/folio-react");
const { panelLayoutThresholds } = await import("@stll/folio-core/panel-layout");
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
    expect(editorRef.current?.getEditorRef()?.getScrollRoot()).toBe(scrollRoot);
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

test("a narrow real editor starts with a collapsed outline, fits the page, and opens a column at the wide threshold", async () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverProbe,
  });

  try {
    const editorRef = React.createRef<DocxEditorRef>();
    const document = createEmptyDocument();
    document.package.document.content = ["First section", "Second section"].map(
      (text) => ({
        type: "paragraph",
        formatting: { styleId: "Heading1" },
        content: [{ type: "run", content: [{ type: "text", text }] }],
      }),
    );
    const mounted = render(
      <IntlProvider
        locale="en"
        messages={bundledEnglishMessages}
        timeZone="UTC"
      >
        <DocxEditor
          document={document}
          initialZoom="fit-width"
          ref={editorRef}
        />
      </IntlProvider>,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());
    const editor = editorRef.current;
    if (!editor) {
      throw new Error("Published editor ref did not mount");
    }
    await act(async () => {
      editor.ensureEditorView({ focus: false });
    });
    const row =
      mounted.container.querySelector<HTMLElement>(".folio-panels-row");
    const scrollRoot = editor.getEditorRef()?.getScrollRoot();
    const pageWidth = editor.getEditorRef()?.getLayout()?.pages.at(0)?.size.w;
    if (!row || !scrollRoot || !pageWidth) {
      throw new Error("Published editor panel geometry is unavailable");
    }

    // Happy DOM has no layout. Model the flex row and its remaining scroll
    // viewport from the track width rendered by the actual editor.
    let hostWidth = 600;
    const scrollWidth = () => {
      const outline = row.querySelector<HTMLElement>(
        ":scope > [data-folio-outline-surface]",
      );
      return hostWidth - Number.parseFloat(outline?.style.width ?? "0");
    };
    Object.defineProperty(row, "clientWidth", {
      configurable: true,
      get: () => hostWidth,
    });
    Object.defineProperties(scrollRoot, {
      clientWidth: { configurable: true, get: scrollWidth },
      offsetWidth: { configurable: true, get: scrollWidth },
    });
    const resize = async () => {
      await act(async () => {
        for (const observer of ResizeObserverProbe.instances) {
          observer.emit(row);
          observer.emit(scrollRoot);
        }
      });
    };
    await resize();
    await waitFor(() => {
      expect(row.dataset["folioOutline"]).toMatch(/^(rail|drawer)$/u);
      expect(
        mounted.container.querySelector(
          '[data-folio-outline-surface="expanded"]',
        ),
      ).toBeNull();
      expect(
        mounted.container.querySelector(
          '[data-folio-outline-surface="column"]',
        ),
      ).toBeNull();
      expect(editor.getZoom()).toBeLessThan(1);
      expect(pageWidth * editor.getZoom()).toBeLessThanOrEqual(scrollWidth());
      expect(pageWidth * editor.getZoom()).toBeGreaterThan(scrollWidth() - 40);
    });

    const expand = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="folio-outline-expand"], [data-testid="toolbar-outline-toggle"]',
    );
    if (!expand) {
      throw new Error("Collapsed outline has no expansion control");
    }
    fireEvent.click(expand);
    await waitFor(() => expect(row.dataset["folioOutline"]).toBe("expanded"));
    await resize();
    await waitFor(() =>
      expect(pageWidth * editor.getZoom()).toBeLessThanOrEqual(scrollWidth()),
    );
    // The explicit open state survives measurement; dismiss it before testing
    // automatic tier selection at the shared wide threshold.
    fireEvent.click(mounted.getByRole("button", { name: /^Close$/u }));
    await waitFor(() =>
      expect(row.dataset["folioOutline"]).not.toBe("expanded"),
    );

    hostWidth = panelLayoutThresholds({
      pageWidth,
      outline: "available",
      comments: "closed",
    }).wide;
    await resize();
    await waitFor(() => {
      expect(row.dataset["folioOutline"]).toBe("column");
      expect(editor.getZoom()).toBe(1);
      expect(pageWidth * editor.getZoom()).toBeLessThanOrEqual(scrollWidth());
    });
    expect(
      mounted.getByRole("button", { name: /^First section$/u }),
    ).toBeTruthy();
  } finally {
    cleanup();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalResizeObserver,
    });
  }
});
