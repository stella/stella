/**
 * Regression coverage for the layout pipeline's commit-vs-discard contract.
 *
 * `runLayoutPipeline` wraps compute + paint + the session-memory commit in one
 * try/catch. The hardening under test: the session is committed only after BOTH
 * layout and paint succeed, and a throw anywhere in the body (notably the paint
 * phase) discards the partial outcome AND leaves the session memory untouched,
 * so the next run re-lays-out instead of skipping on a layout it never painted.
 *
 * Headless setup: a fake DOM (createElement -> FakeElement whose `getContext`
 * returns a deterministic `measureText`) backs BOTH the canvas measurement seam
 * the pipeline installs and the paint phase, so compute and paint run without a
 * browser. Globals are swapped per-test and restored, and the canvas context +
 * measure caches are reset so nothing leaks across files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import type { LayoutInstrumentation } from "../layout-engine/layoutInstrumentation";
import { clearAllCaches } from "../layout-engine/measure/cache";
import { resetCanvasContext } from "../layout-engine/measure/measureContainer";
import { LayoutPainter } from "../layout-painter";
import { LayoutSelectionGate } from "../paged-layout/LayoutSelectionGate";
import { schema } from "../prosemirror/schema";
import { runLayoutPipeline } from "./layoutPipeline";
import type { LayoutPipelineDeps } from "./layoutPipeline";
import { createLayoutSession } from "./layoutSession";
import type { LayoutSession } from "./layoutSession";

// --- Minimal fake DOM (paragraph rendering only) ---------------------------
// Adapted from the proven fake element in renderPage-watermark-incremental;
// the pipeline's paint path only renders plain paragraphs here.

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private ownText = "";
  readonly attributes = new Map<string, string>();
  readonly classList: { add: (...names: string[]) => void };
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
    this.classList = {
      add: (...names: string[]) => {
        const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
        for (const name of names) {
          classes.add(name);
        }
        this.className = Array.from(classes).join(" ");
      },
    };
  }

  get firstChild(): FakeElement | null {
    return this.children.at(0) ?? null;
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(_value: string) {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children = [];
    this.ownText = "";
  }

  get textContent(): string {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      this.attach(child);
      this.children.push(child);
    }
  }

  prepend(...children: FakeElement[]): void {
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (!child) {
        continue;
      }
      this.attach(child);
      this.children.unshift(child);
    }
  }

  appendChild(child: FakeElement): FakeElement {
    this.append(child);
    return child;
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    if (!before) {
      this.append(child);
      return child;
    }
    const index = this.children.indexOf(before);
    if (index === -1) {
      this.append(child);
      return child;
    }
    this.attach(child);
    this.children.splice(index, 0, child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index !== -1) {
      parent.children.splice(index, 1);
    }
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  getContext(_contextId: "2d"): CanvasRenderingContext2D {
    return {
      font: "",
      measureText(text: string) {
        return {
          width: text.length * 7,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
        };
      },
    } as CanvasRenderingContext2D;
  }

  getBoundingClientRect(): DOMRect {
    return {
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }

  querySelector(selector: string): FakeElement | null {
    return findByClass(this, classFromSelector(selector));
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    collectByClass(this, classFromSelector(selector), out);
    return out;
  }

  private attach(child: FakeElement): void {
    child.remove();
    child.parentElement = this;
  }
}

const CLASS_SELECTOR_RE = /\.(?<cls>[\w-]+)/u;

const classFromSelector = (selector: string): string =>
  CLASS_SELECTOR_RE.exec(selector)?.groups?.["cls"] ?? "";

const hasClass = (element: FakeElement, className: string): boolean =>
  element.className.split(/\s+/u).includes(className);

function findByClass(root: FakeElement, className: string): FakeElement | null {
  for (const child of root.children) {
    if (hasClass(child, className)) {
      return child;
    }
    const inner = findByClass(child, className);
    if (inner) {
      return inner;
    }
  }
  return null;
}

function collectByClass(
  root: FakeElement,
  className: string,
  out: FakeElement[],
): void {
  for (const child of root.children) {
    if (hasClass(child, className)) {
      out.push(child);
    }
    collectByClass(child, className, out);
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
  createTextNode(text: string): FakeElement {
    const node = new FakeElement("#text");
    node.textContent = text;
    return node;
  },
};

// The fake element structurally covers the subset of the DOM the paint phase
// touches; the pipeline only forwards the container to `renderPages`.
const asContainer = (value: object): HTMLDivElement =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake DOM container
  value as unknown as HTMLDivElement;

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class FakeCustomEvent<T> {
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly detail: T | null;
  readonly type: string;

  constructor(type: string, init: CustomEventInit<T> = {}) {
    this.type = type;
    this.detail = init.detail ?? null;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
  }
}

// --- Global swap plumbing ---------------------------------------------------

const originalGlobalDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();

function setGlobal(name: string, value: unknown): void {
  if (!originalGlobalDescriptors.has(name)) {
    originalGlobalDescriptors.set(
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

function restoreGlobals(): void {
  for (const [name, descriptor] of originalGlobalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  originalGlobalDescriptors.clear();
}

// --- Pipeline deps + state builders ----------------------------------------

const PAGE_SIZE = { w: 816, h: 1056 };
const MARGINS = {
  top: 72,
  right: 72,
  bottom: 72,
  left: 72,
  header: 36,
  footer: 36,
};

const makeState = (): EditorState =>
  EditorState.create({
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Hello world")]),
      schema.node("paragraph", null, [schema.text("Second paragraph here.")]),
    ]),
  });

type DepsOverrides = Partial<LayoutPipelineDeps<null>>;

const makeDeps = (
  session: LayoutSession,
  overrides: DepsOverrides = {},
): LayoutPipelineDeps<null> => ({
  contentWidth: PAGE_SIZE.w - MARGINS.left - MARGINS.right,
  columns: undefined,
  pageSize: PAGE_SIZE,
  margins: MARGINS,
  pageGap: 24,
  syncCoordinator: new LayoutSelectionGate(),
  headerContent: null,
  footerContent: null,
  firstPageHeaderContent: null,
  firstPageFooterContent: null,
  headerContentRId: null,
  footerContentRId: null,
  firstPageHeaderContentRId: null,
  firstPageFooterContentRId: null,
  sectionHeaderFooterRefs: undefined,
  theme: undefined,
  sectionProperties: null,
  document: null,
  defaultTabStop: undefined,
  styles: null,
  layout: null,
  hfPMs: null,
  painter: null,
  pagesContainer: null,
  session,
  renderHfFromContentOrPm: () => undefined,
  renderHeaderFooterContentByRId: () => undefined,
  documentFontsAreLoaded: () => true,
  buildFootnoteRenderItems: () => new Map(),
  describeInvalidHighlightMarks: () => "",
  emptyTemplatePreviewEntries: [],
  ...overrides,
});

// Capture the instrumentation callbacks the pipeline fires on
// complete/error without spying on a directly-imported module.
let layoutCompletes: { reason: string }[] = [];
let layoutErrors: { message: string; reason: string }[] = [];

describe("runLayoutPipeline", () => {
  beforeEach(() => {
    setGlobal("document", fakeDocument);
    setGlobal("HTMLElement", FakeElement);
    setGlobal("IntersectionObserver", FakeIntersectionObserver);
    setGlobal("CustomEvent", FakeCustomEvent);
    setGlobal("window", { innerHeight: 900 });
    resetCanvasContext();
    clearAllCaches();
    layoutCompletes = [];
    layoutErrors = [];
    const instrumentation: LayoutInstrumentation = {
      onLayoutComplete: (event) => {
        layoutCompletes.push(event);
      },
      onLayoutError: (event) => {
        layoutErrors.push(event);
      },
    };
    globalThis.__folioLayoutInstrumentation = instrumentation;
  });

  afterEach(() => {
    globalThis.__folioLayoutInstrumentation = undefined;
    restoreGlobals();
    resetCanvasContext();
    clearAllCaches();
  });

  test("commits the session memory and returns a painted outcome on success", () => {
    const session = createLayoutSession();
    const state = makeState();
    const container = fakeDocument.createElement("div");
    const deps = makeDeps(session, {
      painter: new LayoutPainter(),
      pagesContainer: asContainer(container),
    });

    const outcome = runLayoutPipeline(deps, state);

    // Outcome is fully populated, including the block lookup the paint phase
    // builds when a painter is attached.
    expect(outcome.blocks?.length ?? 0).toBeGreaterThan(0);
    expect(outcome.measures?.length ?? 0).toBeGreaterThan(0);
    expect(outcome.layout?.pages.length ?? 0).toBeGreaterThan(0);
    expect(outcome.blockLookup).toBeInstanceOf(Map);
    expect(outcome.blockLookup?.size ?? 0).toBeGreaterThan(0);

    // Session memory is committed only after layout AND paint succeed.
    expect(session.artifacts).not.toBeNull();
    expect(session.artifacts?.blocks.length ?? 0).toBeGreaterThan(0);
    expect(session.artifacts?.measures.length ?? 0).toBeGreaterThan(0);
    expect(session.lastEditorState).toBe(state);
    expect(session.lastPmDoc).toBe(state.doc);
    expect(session.usedLoadedFonts).toBe(true);
    expect(session.lastTemplatePreview).toEqual({ entries: [], mode: "plain" });

    expect(layoutCompletes).toHaveLength(1);
    expect(layoutErrors).toHaveLength(0);
  });

  test("commits the session without a block lookup when no painter is attached", () => {
    const session = createLayoutSession();
    const state = makeState();
    const deps = makeDeps(session); // painter + pagesContainer default to null

    const outcome = runLayoutPipeline(deps, state);

    expect(outcome.layout?.pages.length ?? 0).toBeGreaterThan(0);
    // Paint phase is skipped, so no block lookup is produced.
    expect(outcome.blockLookup).toBeUndefined();
    // The layout still succeeded, so the session is committed.
    expect(session.artifacts).not.toBeNull();
    expect(session.lastEditorState).toBe(state);
    expect(layoutCompletes).toHaveLength(1);
  });

  test("discards the outcome and leaves the session unmutated when the paint phase throws", () => {
    const session = createLayoutSession();
    const state = makeState();

    // The throw lands in the render-pages (paint) phase: `renderPages` is a
    // direct import (not injectable), so we force it to throw on its very first
    // container access. This is after the session is STAGED (measure step) but
    // before it is COMMITTED, exactly the window the hardening protects.
    const throwingContainer = asContainer(
      new Proxy(
        {},
        {
          get() {
            throw new Error("paint phase exploded");
          },
        },
      ),
    );
    const deps = makeDeps(session, {
      painter: new LayoutPainter(),
      pagesContainer: throwingContainer,
    });

    // The catch swallows the throw — the pipeline must not rethrow.
    const outcome = runLayoutPipeline(deps, state);

    // Nothing applied: the partial outcome is dropped.
    expect(outcome).toEqual({});

    // The session keeps its pre-call values, so the next run re-lays-out
    // instead of skipping on pages that were never painted.
    expect(session.artifacts).toBeNull();
    expect(session.lastEditorState).toBeNull();
    expect(session.lastPmDoc).toBeNull();
    expect(session.usedLoadedFonts).toBe(false);
    expect(session.lastTemplatePreview).toEqual({ entries: [], mode: "plain" });

    // The error recorder ran; no completion was recorded.
    expect(layoutErrors).toHaveLength(1);
    expect(layoutCompletes).toHaveLength(0);
  });
});

describe("createLayoutSession", () => {
  test("returns the documented empty defaults", () => {
    expect(createLayoutSession()).toEqual({
      artifacts: null,
      lastEditorState: null,
      lastPmDoc: null,
      usedLoadedFonts: false,
      lastTemplatePreview: { entries: [], mode: "plain" },
    });
  });
});
