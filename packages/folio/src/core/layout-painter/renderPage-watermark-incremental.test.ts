import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Page } from "../layout-engine/types";
import type { Watermark } from "../types/document";
import { renderPages } from "./renderPage";

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

  before(...children: FakeElement[]): void {
    const parent = this.parentElement;
    if (!parent) {
      return;
    }
    let index = parent.children.indexOf(this);
    if (index === -1) {
      return;
    }
    for (const child of children) {
      parent.attach(child);
      parent.children.splice(index, 0, child);
      index++;
    }
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

  replaceWith(replacement: FakeElement): void {
    const parent = this.parentElement;
    if (!parent) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index === -1) {
      return;
    }
    replacement.remove();
    replacement.parentElement = parent;
    parent.children[index] = replacement;
    this.parentElement = null;
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
    return findByClass(
      this,
      classFromSelector(selector),
      isScopeChild(selector),
    );
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    collectByClass(
      this,
      classFromSelector(selector),
      out,
      isScopeChild(selector),
    );
    return out;
  }

  private attach(child: FakeElement): void {
    child.remove();
    child.parentElement = this;
  }
}

const CLASS_SELECTOR_RE = /\.([\w-]+)/u;

const classFromSelector = (selector: string): string =>
  CLASS_SELECTOR_RE.exec(selector)?.at(1) ?? "";

const isScopeChild = (selector: string): boolean =>
  selector.includes(":scope >");

const hasClass = (element: FakeElement, className: string): boolean =>
  element.className.split(/\s+/u).includes(className);

function findByClass(
  root: FakeElement,
  className: string,
  directChildOnly: boolean,
): FakeElement | null {
  for (const child of root.children) {
    if (hasClass(child, className)) {
      return child;
    }
    if (directChildOnly) {
      continue;
    }
    const inner = findByClass(child, className, false);
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
  directChildOnly: boolean,
): void {
  for (const child of root.children) {
    if (hasClass(child, className)) {
      out.push(child);
    }
    if (!directChildOnly) {
      collectByClass(child, className, out, false);
    }
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

const watermarkByHeaderRId = new Map<string, Watermark>([
  ["h1", { kind: "text", text: "DRAFT" }],
]);

function makePages(firstPageHeaderRId: string): Page[] {
  return Array.from({ length: 8 }, (_unused, index) =>
    makePage(index + 1, index === 0 ? firstPageHeaderRId : "h1"),
  );
}

function makePage(number: number, headerRId: string): Page {
  return {
    number,
    sectionPageNumber: number,
    fragments: [],
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    size: { w: 816, h: 1056 },
    headerFooterRefs: { headerDefault: headerRId },
  };
}

describe("renderPages watermark overlays", () => {
  beforeEach(() => {
    setGlobal("HTMLElement", FakeElement);
    setGlobal("IntersectionObserver", FakeIntersectionObserver);
    setGlobal("CustomEvent", FakeCustomEvent);
    setGlobal("window", { innerHeight: 900 });
  });

  afterEach(() => {
    restoreGlobals();
  });

  test("removes a stale per-header watermark during an incremental rerender", () => {
    const container = fakeDocument.createElement("div");
    const options = {
      document: fakeDocument as unknown as Document,
      watermarkByHeaderRId,
    };

    renderPages(makePages("h1"), container as unknown as HTMLElement, options);
    const firstShell = container.children.at(0);
    if (!firstShell) {
      throw new TypeError("expected first page shell");
    }
    expect(
      firstShell.querySelector(":scope > .layout-page-watermark")?.textContent,
    ).toBe("DRAFT");

    renderPages(makePages("h2"), container as unknown as HTMLElement, options);

    expect(container.children.at(0)).toBe(firstShell);
    expect(
      firstShell.querySelector(":scope > .layout-page-watermark"),
    ).toBeNull();
  });
});
