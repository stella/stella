/**
 * Feature-registry dispatch tests.
 *
 * Asserts the core contract:
 *  - Modules registered by kind are dispatched on matching fragments.
 *  - Unknown kinds and fragments without block/measure hit the fallback.
 *  - Duplicate registration panics (prevents silent overrides).
 */

import { describe, expect, test } from "bun:test";

import type {
  Fragment,
  ImageBlock,
  ImageFragment,
  ImageMeasure,
  TableBlock,
  TableFragment,
  TableMeasure,
} from "../../layout-engine/types";
import type { RenderContext } from "../renderUtils";
import { createFeatureRegistry } from "./registry";
import type { FeatureModule } from "./types";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = {
    add: (...tokens: string[]) => {
      this.className = [this.className, ...tokens].filter(Boolean).join(" ");
    },
  };
  src = "";
  alt = "";
  draggable = false;
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
}

const fakeDocument = {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  },
} as unknown as Document;

const ctx: RenderContext = {
  pageNumber: 1,
  totalPages: 1,
  section: "body",
};

const imageFragment: ImageFragment = {
  kind: "image",
  blockId: "b1",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
};

const imageBlock: ImageBlock = {
  kind: "image",
  id: "b1",
  src: "img.png",
  width: 100,
  height: 80,
};

const imageMeasure: ImageMeasure = {
  kind: "image",
  width: 100,
  height: 80,
};

const tableFragment: TableFragment = {
  kind: "table",
  blockId: "t1",
  x: 0,
  y: 0,
  width: 400,
  height: 100,
  fromRow: 0,
  toRow: 1,
};

const tableBlock: TableBlock = {
  kind: "table",
  id: "t1",
  rows: [{ cells: [] }],
};

const tableMeasure: TableMeasure = {
  kind: "table",
  rows: [{ cells: [], height: 0 }],
  columnWidths: [],
  totalWidth: 400,
  totalHeight: 0,
};

describe("createFeatureRegistry", () => {
  test("dispatches to the module registered for the fragment's kind", () => {
    let called = false;
    const imageMod: FeatureModule<"image"> = {
      kind: "image",
      render() {
        called = true;
        const el = new FakeElement("div");
        el.dataset["from"] = "imageMod";
        return el as unknown as HTMLElement;
      },
    };
    const registry = createFeatureRegistry();
    registry.register(imageMod);

    const out = registry.render({
      fragment: imageFragment,
      block: imageBlock,
      measure: imageMeasure,
      context: ctx,
      doc: fakeDocument,
    }) as unknown as FakeElement;

    expect(called).toBe(true);
    expect(out.dataset["from"]).toBe("imageMod");
  });

  test("routes by kind, not by accident — wrong-kind modules are ignored", () => {
    const imageMod: FeatureModule<"image"> = {
      kind: "image",
      render() {
        const el = new FakeElement("div");
        el.dataset["from"] = "imageMod";
        return el as unknown as HTMLElement;
      },
    };
    const tableMod: FeatureModule<"table"> = {
      kind: "table",
      render() {
        const el = new FakeElement("div");
        el.dataset["from"] = "tableMod";
        return el as unknown as HTMLElement;
      },
    };
    const registry = createFeatureRegistry();
    registry.register(imageMod);
    registry.register(tableMod);

    const out = registry.render({
      fragment: tableFragment,
      block: tableBlock,
      measure: tableMeasure,
      context: ctx,
      doc: fakeDocument,
    }) as unknown as FakeElement;

    expect(out.dataset["from"]).toBe("tableMod");
  });

  test("falls back when no module matches the kind", () => {
    let fallbackCalled = false;
    const registry = createFeatureRegistry({
      fallback: ({ doc }) => {
        fallbackCalled = true;
        return doc.createElement("div") as unknown as HTMLElement;
      },
    });

    const unknownFragment = {
      kind: "image" as const,
      blockId: "z",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } satisfies Fragment;

    registry.render({
      fragment: unknownFragment,
      block: imageBlock,
      measure: imageMeasure,
      context: ctx,
      doc: fakeDocument,
    });

    expect(fallbackCalled).toBe(true);
  });

  test("falls back when block/measure are missing even if a module is registered", () => {
    let fallbackCalled = false;
    let moduleCalled = false;
    const registry = createFeatureRegistry({
      fallback: ({ doc }) => {
        fallbackCalled = true;
        return doc.createElement("div") as unknown as HTMLElement;
      },
    });
    registry.register({
      kind: "image",
      render() {
        moduleCalled = true;
        return fakeDocument.createElement("div");
      },
    });

    registry.render({
      fragment: imageFragment,
      block: undefined,
      measure: undefined,
      context: ctx,
      doc: fakeDocument,
    });

    expect(fallbackCalled).toBe(true);
    expect(moduleCalled).toBe(false);
  });

  test("rejects duplicate registration", () => {
    const registry = createFeatureRegistry();
    const mod: FeatureModule<"image"> = {
      kind: "image",
      render: () => fakeDocument.createElement("div"),
    };
    registry.register(mod);
    expect(() => registry.register(mod)).toThrow();
  });

  test("get() returns the registered module, undefined otherwise", () => {
    const registry = createFeatureRegistry();
    const mod: FeatureModule<"image"> = {
      kind: "image",
      render: () => fakeDocument.createElement("div"),
    };
    registry.register(mod);
    expect(registry.get("image")).toBe(mod);
    expect(registry.get("table")).toBeUndefined();
    expect(registry.has("image")).toBe(true);
    expect(registry.has("textBox")).toBe(false);
  });
});
