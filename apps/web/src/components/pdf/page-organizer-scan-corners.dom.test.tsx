import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import type { ScanCornerSuggestion, ScanQuad } from "@stll/scan-engine/types";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { PageOrganizerScanCorners } =
  await import("./page-organizer-scan-corners");
const { fullPageScanCorners } =
  await import("./page-organizer-scan-corners.logic");

afterEach(cleanup);
afterAll(async () => {
  await act(async () => await sleep(50));
  await GlobalRegistrator.unregister();
});

const WIDTH = 201;
const HEIGHT = 301;
const DETECTED = {
  topLeft: { x: 20, y: 30 },
  topRight: { x: 180, y: 30 },
  bottomRight: { x: 180, y: 270 },
  bottomLeft: { x: 20, y: 270 },
} satisfies ScanQuad;

const mount = (suggestion: ScanCornerSuggestion) => {
  const changes: ScanQuad[] = [];
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <PageOrganizerScanCorners
        width={WIDTH}
        height={HEIGHT}
        imageUrl="data:image/png;base64,"
        suggestion={suggestion}
        onChange={(corners) => {
          changes.push(corners);
        }}
      />
    </IntlProvider>,
  );
  return { ...view, changes };
};

test("dragging a scan corner maps displayed distance to source pixels and stops on release", async () => {
  const view = mount({ type: "detected", corners: DETECTED });
  const handle = view.getByRole("button", {
    name: messages.workspaces.pdf.pageEditor.scanCornerTopLeft,
  });
  const surface = handle.parentElement;
  if (!surface) {
    throw new Error("Missing scan corner surface");
  }
  Object.defineProperty(surface, "getBoundingClientRect", {
    value: () => new DOMRect(0, 0, 100, 150),
  });
  const captured: number[] = [];
  Object.defineProperty(handle, "setPointerCapture", {
    value: (pointerId: number) => captured.push(pointerId),
  });
  await act(async () => {
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 15,
    });
    await sleep(0);
  });
  fireEvent.pointerMove(handle, { pointerId: 7, clientX: 20, clientY: 25 });
  expect(captured).toEqual([7]);
  expect(view.changes.at(-1)?.topLeft).toEqual({ x: 40, y: 50 });
  expect(handle.style.left).toBe("20%");
  fireEvent.pointerUp(handle, { pointerId: 7 });
  const changeCount = view.changes.length;
  fireEvent.pointerMove(handle, { pointerId: 7, clientX: 30, clientY: 35 });
  expect(view.changes).toHaveLength(changeCount);
});

test("arrow keys nudge scan corners with a larger shift step and keep a convex in-frame page", () => {
  const view = mount({ type: "detected", corners: DETECTED });
  const handle = view.getByRole("button", {
    name: messages.workspaces.pdf.pageEditor.scanCornerTopLeft,
  });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(view.changes.at(-1)?.topLeft).toEqual({ x: 21, y: 30 });
  fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
  expect(view.changes.at(-1)?.topLeft).toEqual({ x: 21, y: 40 });
  for (let index = 0; index < 4; index += 1) {
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
  }
  expect(view.changes.at(-1)?.topLeft.x).toBe(0);
  for (let index = 0; index < 30; index += 1) {
    fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
  }
  expect(view.changes.at(-1)?.topLeft.y).toBeLessThan(DETECTED.bottomLeft.y);
});

test("use full page resets all four edited corners and reports them to the caller", () => {
  const view = mount({ type: "detected", corners: DETECTED });
  fireEvent.click(
    view.getByRole("button", {
      name: messages.workspaces.pdf.pageEditor.scanUseFullPage,
    }),
  );
  expect(view.changes.at(-1)).toEqual(fullPageScanCorners(WIDTH, HEIGHT));
  const topLeft = view.getByRole("button", {
    name: messages.workspaces.pdf.pageEditor.scanCornerTopLeft,
  });
  const bottomRight = view.getByRole("button", {
    name: messages.workspaces.pdf.pageEditor.scanCornerBottomRight,
  });
  expect(topLeft.style.left).toBe("0%");
  expect(topLeft.style.top).toBe("0%");
  expect(bottomRight.style.left).toBe("100%");
  expect(bottomRight.style.top).toBe("100%");
});

test("an uncertain detection starts at the full frame with an accessible explanation", () => {
  const view = mount({
    type: "full-frame",
    corners: fullPageScanCorners(WIDTH, HEIGHT),
  });
  expect(view.getByRole("status").textContent).toBe(
    messages.workspaces.pdf.pageEditor.scanFullPageFallback,
  );
  expect(
    view.getByRole("button", {
      name: messages.workspaces.pdf.pageEditor.scanCornerBottomRight,
    }).style.left,
  ).toBe("100%");
  expect(view.changes).toHaveLength(0);
});
