import { describe, expect, test } from "bun:test";

import {
  captureViewportCenterZoomAnchor,
  getViewportCenterZoomAnchorForZoomChange,
  getScrollTopForZoomAnchor,
} from "./zoomScrollAnchor";

describe("zoomScrollAnchor", () => {
  test("keeps the viewport center anchored when zooming in", () => {
    const anchor = captureViewportCenterZoomAnchor({
      clientHeight: 800,
      scrollTop: 4000,
      zoom: 1,
    });

    expect(getScrollTopForZoomAnchor(anchor, 1.5)).toBe(6200);
  });

  test("keeps the viewport center anchored when zooming out", () => {
    const anchor = captureViewportCenterZoomAnchor({
      clientHeight: 800,
      scrollTop: 6200,
      zoom: 1.5,
    });

    expect(getScrollTopForZoomAnchor(anchor, 1)).toBe(4000);
  });

  test("does not keep a stale anchor for unchanged zoom", () => {
    const anchor = getViewportCenterZoomAnchorForZoomChange({
      clientHeight: 800,
      currentZoom: 1,
      nextZoom: 1,
      pendingAnchor: null,
      scrollTop: 4000,
    });

    expect(anchor).toBeNull();
  });

  test("preserves a pending anchor for repeated zoom input before commit", () => {
    const pendingAnchor = captureViewportCenterZoomAnchor({
      clientHeight: 800,
      scrollTop: 4000,
      zoom: 1,
    });

    const anchor = getViewportCenterZoomAnchorForZoomChange({
      clientHeight: 800,
      currentZoom: 1.2,
      nextZoom: 1.2,
      pendingAnchor,
      scrollTop: 4200,
    });

    expect(anchor).toBe(pendingAnchor);
  });

  test("clears a pending anchor when zoom returns to its original value", () => {
    const pendingAnchor = captureViewportCenterZoomAnchor({
      clientHeight: 800,
      scrollTop: 4000,
      zoom: 1,
    });

    const anchor = getViewportCenterZoomAnchorForZoomChange({
      clientHeight: 800,
      currentZoom: 1.5,
      nextZoom: 1,
      pendingAnchor,
      scrollTop: 6200,
    });

    expect(anchor).toBeNull();
  });
});
