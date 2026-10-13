import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { useInspectorPaneWidth } from "./use-pane-width";

// The handle owns a pointer stream, so what it hands back has to cover every
// way that stream can end. A drag left open resizes the pane on the next
// pointer movement with no button held, which is why the cancel paths are part
// of the contract rather than an optimization.
const HandleProbe = () => {
  const { resizeHandleProps } = useInspectorPaneWidth({
    sidebarWidth: 256,
    viewportWidth: 1920,
  });

  return <span>{Object.keys(resizeHandleProps).toSorted().join(" ")}</span>;
};

describe("useInspectorPaneWidth", () => {
  test("hands the handle every end-of-stream path, not only pointerup", () => {
    const markup = renderToStaticMarkup(<HandleProbe />);

    expect(markup).toContain("onPointerUp");
    expect(markup).toContain("onPointerCancel");
    expect(markup).toContain("onLostPointerCapture");
  });

  test("renders without browser storage", () => {
    // Persistence belongs to the host, so rendering never reads browser storage.
    expect(() => renderToStaticMarkup(<HandleProbe />)).not.toThrow();
  });
});
