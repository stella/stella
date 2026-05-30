/**
 * Text-box module contract test. Verifies kind discriminator and that
 * style attributes (fill, border, padding) flow through the module.
 */

import { describe, expect, test } from "bun:test";

import type {
  TextBoxBlock,
  TextBoxFragment,
  TextBoxMeasure,
} from "../../../layout-engine/types";
import { TEXTBOX_CLASS_NAMES } from "../../renderTextBox";
import type { RenderContext } from "../../renderUtils";
import { textBoxModule } from "./textBox";

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

describe("textBoxModule", () => {
  test("identifies itself as the textBox kind", () => {
    expect(textBoxModule.kind).toBe("textBox");
  });

  test("renders a text box fragment with fill, border, and padding", () => {
    const fragment: TextBoxFragment = {
      kind: "textBox",
      blockId: "tb1",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    };
    const block: TextBoxBlock = {
      kind: "textBox",
      id: "tb1",
      width: 200,
      height: 100,
      fillColor: "var(--test-fill)",
      outlineWidth: 2,
      outlineColor: "var(--test-outline)",
      outlineStyle: "solid",
      margins: { top: 4, right: 6, bottom: 4, left: 6 },
      content: [],
    };
    const measure: TextBoxMeasure = {
      kind: "textBox",
      width: 200,
      height: 100,
      innerMeasures: [],
    };

    const el = textBoxModule.render({
      fragment,
      block,
      measure,
      context: ctx,
      doc: fakeDocument,
    }) as unknown as FakeElement;

    expect(el.className).toBe(TEXTBOX_CLASS_NAMES.textBox);
    expect(el.style["backgroundColor"]).toBe("var(--test-fill)");
    expect(el.style["border"]).toBe("2px solid var(--test-outline)");
    expect(el.style["padding"]).toBe("4px 6px 4px 6px");
    expect(el.dataset["blockId"]).toBe("tb1");
  });
});
