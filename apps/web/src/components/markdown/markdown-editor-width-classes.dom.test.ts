import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
// Installed the way the host installs it: only where EditContext is missing.
// happy-dom has none of the legacy editing commands the polyfill wraps on
// install; inert ones are enough, since the test never types.
Object.assign(document, {
  execCommand: () => false,
  queryCommandEnabled: () => false,
  queryCommandState: () => false,
  queryCommandSupported: () => false,
  queryCommandValue: () => "",
});
await import("@neftaly/editcontext-polyfill");
const { EditorModel, EditorView, StringValue } =
  await import("@vscode/markdown-editor");

// The engine sizes its content inset from width classes it sets from a
// ResizeObserver. The browser delivers that callback after layout and before
// paint, so whatever the callback applies synchronously is in the first frame;
// anything it defers to `requestAnimationFrame` lands a frame later, after the
// document has already painted once. These stand-ins let the test deliver the
// observer callback and hold animation frames back, which is exactly the
// window between the editor's first layout and its second frame.
type HeldObserver = {
  notify: ResizeObserverCallback;
  observer: ResizeObserver;
};
let observers: HeldObserver[] = [];
let heldFrames: FrameRequestCallback[] = [];
const realResizeObserver = globalThis.ResizeObserver;
const realRequestAnimationFrame = globalThis.requestAnimationFrame;

beforeEach(() => {
  observers = [];
  heldFrames = [];
  globalThis.ResizeObserver = class HeldResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observers.push({ notify: callback, observer: this });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback) => {
    heldFrames.push(callback);
    return heldFrames.length;
  };
});
afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  globalThis.requestAnimationFrame = realRequestAnimationFrame;
  document.body.replaceChildren();
});
afterAll(unregisterDomEnvironment);

/** Mounts a real editor whose root reports `width` CSS pixels, then delivers
 * the layout pass's resize notification without running any later frame. */
const mountAtWidth = (width: number) => {
  const model = new EditorModel();
  model.replaceSourceText(new StringValue("# Heading\n\nA paragraph.\n"));
  const view = new EditorView(model);
  Object.defineProperty(view.element, "clientWidth", { value: width });
  document.body.append(view.element);
  expect(observers.length).toBeGreaterThan(0);
  for (const { notify, observer } of observers) {
    notify([], observer);
  }
  return view;
};

test.each([
  { width: 280, medium: false, narrow: true },
  { width: 480, medium: false, narrow: false },
  { width: 900, medium: true, narrow: false },
])(
  "a $width px editor has its final inset classes before the next frame",
  ({ width, medium, narrow }) => {
    const view = mountAtWidth(width);
    expect(heldFrames.length).toBeGreaterThan(0);
    // No frame has run yet: this is what the first paint shows.
    const classes = view.element.classList;
    expect(classes.contains("md-editor-medium-margins")).toBe(medium);
    expect(classes.contains("md-editor-narrow")).toBe(narrow);

    // The deferred frame only measures; it must not move the inset again.
    for (const frame of heldFrames.splice(0)) {
      frame(0);
    }
    expect(classes.contains("md-editor-medium-margins")).toBe(medium);
    expect(classes.contains("md-editor-narrow")).toBe(narrow);
    view.dispose();
  },
);
