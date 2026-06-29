import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getCaretPositionFromDom } from "./clickToPositionDom";

class FakeHTMLElement {
  dataset: Record<string, string> = {};
  firstChild: unknown;
  private readonly rect: Partial<DOMRect>;
  private readonly height: number;
  readonly classList = {
    contains: (className: string) => this.classes.has(className),
  };
  private readonly classes = new Set<string>();
  private readonly children: FakeHTMLElement[] = [];
  private parent: FakeHTMLElement | null = null;

  constructor(
    classes: string[] = [],
    rectInput: Partial<DOMRect> = {},
    heightInput = 0,
  ) {
    this.rect = rectInput;
    this.height = heightInput;
    for (const className of classes) {
      this.classes.add(className);
    }
  }

  get offsetHeight(): number {
    return this.height;
  }

  get ownerDocument(): { createRange: () => Range } {
    return fakeDocument;
  }

  append(...children: FakeHTMLElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  querySelectorAll(selector: string): FakeHTMLElement[] {
    const out: FakeHTMLElement[] = [];
    this.collect(selector, out);
    return out;
  }

  querySelector(selector: string): FakeHTMLElement | null {
    return this.querySelectorAll(selector).at(0) ?? null;
  }

  closest(selector: string): this | null {
    if (this.matches(selector)) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }

  getBoundingClientRect(): DOMRect {
    return rect(this.rect);
  }

  private collect(selector: string, out: FakeHTMLElement[]): void {
    for (const child of this.children) {
      if (child.matches(selector)) {
        out.push(child);
      }
      child.collect(selector, out);
    }
  }

  private matches(selector: string): boolean {
    if (selector.includes(".layout-page-content")) {
      return this.classes.has("layout-run-text");
    }
    if (selector === ".layout-page") {
      return this.classes.has("layout-page");
    }
    if (selector === ".layout-line") {
      return this.classes.has("layout-line");
    }
    return false;
  }
}

const textNode = { nodeType: 3, length: 5 };
let rangeHeight = 18;
const fakeDocument = {
  createRange: () =>
    ({
      setStart: () => undefined,
      setEnd: () => undefined,
      getBoundingClientRect: () =>
        rect({ left: 12, top: 20, height: rangeHeight }),
    }) as Range,
};

const rect = (values: Partial<DOMRect>): DOMRect =>
  ({
    x: values.left ?? 0,
    y: values.top ?? 0,
    left: values.left ?? 0,
    top: values.top ?? 0,
    right: values.right ?? 0,
    bottom: values.bottom ?? 0,
    width: values.width ?? 0,
    height: values.height ?? 0,
    toJSON: () => values,
  }) as DOMRect;

const buildContainer = (): HTMLElement => {
  const container = new FakeHTMLElement();
  const page = new FakeHTMLElement(["layout-page"]);
  page.dataset["pageNumber"] = "1";
  const content = new FakeHTMLElement(["layout-page-content"]);
  const line = new FakeHTMLElement(["layout-line"], {}, 80);
  const span = new FakeHTMLElement(
    ["layout-run-text"],
    { left: 10, top: 20 },
    18,
  );
  span.dataset["pmStart"] = "1";
  span.dataset["pmEnd"] = "6";
  span.firstChild = textNode;

  container.append(page);
  page.append(content);
  content.append(line);
  line.append(span);

  return container as unknown as HTMLElement;
};

let originalHTMLElement: unknown;
let originalNode: unknown;

beforeEach(() => {
  originalHTMLElement = globalThis.HTMLElement;
  originalNode = globalThis.Node;
  Object.assign(globalThis, {
    HTMLElement: FakeHTMLElement,
    Node: { TEXT_NODE: 3 },
  });
});

afterEach(() => {
  Object.assign(globalThis, {
    HTMLElement: originalHTMLElement,
    Node: originalNode,
  });
});

describe("getCaretPositionFromDom caret height", () => {
  test("uses the collapsed range height instead of the full line height", () => {
    rangeHeight = 18;

    const caret = getCaretPositionFromDom(buildContainer(), 3, rect({}));

    expect(caret?.height).toBe(18);
  });

  test("falls back to line height when the range reports zero height", () => {
    rangeHeight = 0;

    const caret = getCaretPositionFromDom(buildContainer(), 3, rect({}));

    expect(caret?.height).toBe(80);
  });
});
