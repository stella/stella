// eigenpal #723 (#719) — a paragraph that carries right-to-left runs (`w:rtl`)
// but no explicit paragraph `w:bidi` flag must still lay out right-to-left.
// The painter renders each run as its own `dir`-marked, bidi-isolated span, so
// without a base direction on the fragment the runs stay in logical (LTR) order
// and reversed Hebrew/Arabic reads backwards. We set the fragment direction
// from first-strong base-direction detection, gated to paragraphs that actually
// contain RTL runs so pure-LTR content is untouched.

import { describe, expect, test } from "bun:test";

import type {
  ParagraphAttrs,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMeasure,
  TextRun,
} from "../layout-engine/types";
import { renderParagraphFragment } from "./renderParagraph";

function createFakeStyle(): Record<string, string> {
  const store: Record<string, string> = {};
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop === "setProperty") {
        return (key: string, value: string) => {
          target[key] = value;
        };
      }
      if (prop === "getPropertyValue") {
        return (key: string) => target[key] ?? "";
      }
      return target[prop];
    },
    set(target, prop: string, value: string) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Record<string, string>;
}

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  innerHTML = "";
  dir = "";
  style: Record<string, string> = createFakeStyle();
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
  prepend(...children: FakeElement[]): void {
    this.children.unshift(...children);
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  getContext(): {
    font: string;
    measureText: (text: string) => { width: number };
  } | null {
    if (this.tagName !== "canvas") {
      return null;
    }
    return { font: "", measureText: (t: string) => ({ width: t.length * 7 }) };
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

function render(runs: TextRun[], attrs?: ParagraphAttrs): HTMLElement {
  const block: ParagraphBlock = { kind: "paragraph", id: "p1", runs, attrs };
  const totalChars = runs.reduce((n, r) => n + r.text.length, 0);
  const measure: ParagraphMeasure = {
    kind: "paragraph",
    lines: [
      {
        fromRun: 0,
        fromChar: 0,
        toRun: Math.max(0, runs.length - 1),
        toChar: totalChars,
        width: 100,
        ascent: 10,
        descent: 3,
        lineHeight: 13,
      },
    ],
    totalHeight: 13,
  };
  const fragment: ParagraphFragment = {
    kind: "paragraph",
    blockId: "p1",
    x: 0,
    y: 0,
    width: 200,
    height: 13,
    fromLine: 0,
    toLine: 1,
  };
  return renderParagraphFragment(
    fragment,
    block,
    measure,
    { pageNumber: 1, totalPages: 1, section: "body" },
    { document: fakeDocument },
  );
}

const text = (value: string, rtl?: boolean): TextRun => ({
  kind: "text",
  text: value,
  ...(rtl === undefined ? {} : { rtl }),
});

describe("Issue #719 — RTL base direction detection", () => {
  test("Hebrew-led paragraph with rtl runs renders dir=rtl", () => {
    expect(render([text("בדיקה 1", true)]).dir).toBe("rtl");
  });

  test("explicit w:bidi paragraph still renders dir=rtl", () => {
    expect(render([text("hello")], { bidi: true }).dir).toBe("rtl");
  });

  test("explicit w:bidi=false wins over rtl runs (stays LTR)", () => {
    // `<w:bidi w:val="0"/>` is an explicit LTR override; first-strong detection
    // must not re-enable RTL for a Hebrew run inside it.
    expect(render([text("בדיקה", true)], { bidi: false }).dir).toBe("");
  });

  test("English-led paragraph with an embedded rtl word stays LTR (no dir)", () => {
    expect(render([text("Hello "), text("שלום", true)]).dir).toBe("");
  });

  test("pure-LTR paragraph is untouched (no dir)", () => {
    expect(render([text("plain text")]).dir).toBe("");
  });

  test("detected-RTL paragraph with no explicit alignment defaults to right-align", () => {
    // Detection must drive the same alignment path as an explicit w:bidi
    // paragraph, not just the `dir` attribute.
    const el = render([text("בדיקה", true)]);
    expect(el.dir).toBe("rtl");
    expect(el.style.textAlign).toBe("right");
  });

  test("rtl runs with only digits/punctuation honour w:rtl (no strong char)", () => {
    expect(render([text("123 .", true)]).dir).toBe("rtl");
  });

  test("Arabic-led paragraph with rtl runs renders dir=rtl", () => {
    expect(render([text("مرحبا", true)]).dir).toBe("rtl");
  });

  test("a CJK-only rtl run resolves LTR (CJK is strong left-to-right)", () => {
    // CJK, Devanagari, Thai, Hangul and kana are Unicode bidi class L, so a
    // w:rtl run containing only such text must lay out LTR — not fall through to
    // the digits/punctuation `honor w:rtl` path. Also guards the RTL char-class
    // against the pasted-glyph corruption that once swallowed most of the BMP.
    expect(render([text("中文", true)]).dir).toBe("");
    expect(render([text("अआ", true)]).dir).toBe("");
  });
});
