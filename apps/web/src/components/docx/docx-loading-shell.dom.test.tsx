import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, render } = await import("@testing-library/react");
const { FIT_TO_WIDTH_MAX_ZOOM, FIT_TO_WIDTH_PADDING_PX, fitWidthZoom } =
  await import("@stll/folio-core/paged-layout/fitWidthZoom");
const { DOCX_EDITOR_FIT_PAGE_WIDTH_CSS, DOCX_PAGE_WIDTH } =
  await import("@/components/docx/docx-page.logic");
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
    const editorPageWidth = DOCX_PAGE_WIDTH * (editorZoom ?? 0);
    expect(Number.parseFloat(page?.style.width ?? "")).toBeCloseTo(
      editorPageWidth,
      6,
    );
    // The cold-load view's CSS twin, `min(page × max zoom, column − padding)`,
    // lands within the editor's rounding of its zoom (under 1% of the page).
    const cssPageWidth = Math.min(
      FIT_TO_WIDTH_MAX_ZOOM * DOCX_PAGE_WIDTH,
      columnWidth - FIT_TO_WIDTH_PADDING_PX,
    );
    expect(Math.abs(cssPageWidth - editorPageWidth)).toBeLessThanOrEqual(
      DOCX_PAGE_WIDTH / 100,
    );
    unmount();
  }
});

test("the cold-load sheet's CSS width is Folio's fit-width rule", () => {
  expect(DOCX_EDITOR_FIT_PAGE_WIDTH_CSS).toBe(
    `min(${String(FIT_TO_WIDTH_MAX_ZOOM * DOCX_PAGE_WIDTH)}px, calc(100cqw - ${String(FIT_TO_WIDTH_PADDING_PX)}px))`,
  );
});
