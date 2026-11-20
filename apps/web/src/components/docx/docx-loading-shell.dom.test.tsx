import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, render } = await import("@testing-library/react");
const { fitWidthZoom } =
  await import("@stll/folio-core/paged-layout/fitWidthZoom");
const { DOCX_PAGE_WIDTH } = await import("@/components/docx-preview-zoom");
const { DocxLoadingShell } = await import("./docx-loading-shell");

const widthDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  ),
  offsetWidth: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  ),
};

// A column with no scrollbar: its border box and content box are as wide.
const setLayoutWidth = (width: number) => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => width,
  });
};

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  for (const [key, descriptor] of Object.entries(widthDescriptors)) {
    if (descriptor !== undefined) {
      Object.defineProperty(HTMLElement.prototype, key, descriptor);
    }
  }
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

// The sheet stands in for the editor while it loads, so its page must take
// the width the editor's fit-width gives the page in the same column, at
// every column width: a page of its own size jumps when the editor mounts.
test("the loading sheet's page takes the editor's fitted page width", async () => {
  for (const columnWidth of [320, 480, 672, 704, 832, 1136, 1600]) {
    setLayoutWidth(columnWidth);
    const { container, unmount } = render(<DocxLoadingShell />);
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    });
    const editorZoom = fitWidthZoom({
      clientWidth: columnWidth,
      offsetWidth: columnWidth,
      pageWidth: DOCX_PAGE_WIDTH,
      reservedEdge: 0,
    }).zoom;
    const page = container.querySelector<HTMLElement>(
      ".folio-docx-preview > div",
    );
    expect(editorZoom).not.toBeNull();
    expect(page?.style.width).toBe(
      `${String(DOCX_PAGE_WIDTH * (editorZoom ?? 0))}px`,
    );
    unmount();
  }
});
