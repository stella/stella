import { describe, expect, test } from "bun:test";

import type { MathRun } from "../layout-engine/types";
import { renderLine } from "./renderParagraph";

// Render-side tests for OMML math runs (`feat/folio-omml-math-render`).
// The painter converts OMML XML to MathML at paint time and injects a
// native `<math>` element. These tests exercise the painter's run
// dispatch using a minimal fake Document so we don't pull in jsdom /
// happy-dom for one feature.

class FakeStyle {
  private values: Record<string, string> = {};
  setProperty(name: string, value: string): void {
    this.values[name] = value;
  }
  getPropertyValue(name: string): string {
    return this.values[name] ?? "";
  }
}

type StyleProxy = FakeStyle & Record<string, string>;

function makeStyle(): StyleProxy {
  const fake = new FakeStyle();
  return new Proxy(fake, {
    get(target, prop) {
      if (prop in target) {
        const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
        if (typeof v === "function") {
          return (v as (...a: unknown[]) => unknown).bind(target);
        }
        return v;
      }
      return target.getPropertyValue(String(prop));
    },
    set(target, prop, value) {
      target.setProperty(String(prop), String(value));
      return true;
    },
  }) as StyleProxy;
}

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  style: StyleProxy = makeStyle();
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  height = 0;
  width = 0;
  src = "";
  alt = "";
  draggable = true;
  classList = {
    add: (...tokens: string[]) => {
      this.className = [this.className, ...tokens].filter(Boolean).join(" ");
    },
  };
  readonly tagName: string;
  #innerHTML = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get innerHTML(): string {
    return this.#innerHTML;
  }

  set innerHTML(value: string) {
    this.#innerHTML = value;
    // Minimal HTML tokeniser: extract top-level open tags so
    // `firstElementChild`/tag walks work for tests that inspect injected
    // MathML. Sufficient for the render tests; not a full HTML parser.
    this.children = parseTopLevelChildren(value);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getContext(): {
    font: string;
    measureText: (text: string) => { width: number };
  } | null {
    if (this.tagName !== "CANVAS") {
      return null;
    }
    return {
      font: "",
      measureText(text: string) {
        return { width: text.length * 7 };
      },
    };
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

/**
 * Tokenise a serialised HTML string into a flat list of top-level
 * children sufficient for tests that inspect tag names and attributes.
 * Nested children are parsed recursively so `findElement` can recurse
 * through the MathML tree.
 */
function parseTopLevelChildren(html: string): FakeElement[] {
  const children: FakeElement[] = [];
  let i = 0;
  while (i < html.length) {
    const openIdx = html.indexOf("<", i);
    if (openIdx === -1) {
      break;
    }
    if (html.startsWith("</", openIdx)) {
      // Stray close tag — skip.
      const closeEnd = html.indexOf(">", openIdx);
      if (closeEnd === -1) {
        break;
      }
      i = closeEnd + 1;
      continue;
    }
    const tagEnd = html.indexOf(">", openIdx);
    if (tagEnd === -1) {
      break;
    }
    const isSelfClose = html[tagEnd - 1] === "/";
    const tagBody = html.slice(openIdx + 1, isSelfClose ? tagEnd - 1 : tagEnd);
    const spaceIdx = tagBody.search(/\s/u);
    const tagName = (
      spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx)
    ).trim();
    const attrText = spaceIdx === -1 ? "" : tagBody.slice(spaceIdx);
    const el = new FakeElement(tagName);
    // Linear-time attribute extraction: walk the text instead of using a
    // regex with alternation that sonarjs flags as super-linear.
    let attrPos = 0;
    while (attrPos < attrText.length) {
      while (attrPos < attrText.length && /\s/u.test(attrText[attrPos] ?? "")) {
        attrPos += 1;
      }
      const eqIdx = attrText.indexOf("=", attrPos);
      if (eqIdx === -1) {
        break;
      }
      const name = attrText.slice(attrPos, eqIdx).trim();
      const quote = attrText[eqIdx + 1];
      if (quote !== '"' && quote !== "'") {
        break;
      }
      const valueEnd = attrText.indexOf(quote, eqIdx + 2);
      if (valueEnd === -1) {
        break;
      }
      el.attributes[name] = attrText.slice(eqIdx + 2, valueEnd);
      attrPos = valueEnd + 1;
    }

    if (isSelfClose) {
      children.push(el);
      i = tagEnd + 1;
      continue;
    }

    // Find matching close tag, tracking depth so nested same-name tags
    // don't terminate prematurely.
    const closeTag = `</${tagName}>`;
    const openTagRe = new RegExp(`<${tagName}(?=[\\s>/])`, "gu");
    let depth = 1;
    let cursor = tagEnd + 1;
    let closeIdx = -1;
    while (cursor < html.length && depth > 0) {
      const nextClose = html.indexOf(closeTag, cursor);
      if (nextClose === -1) {
        break;
      }
      openTagRe.lastIndex = cursor;
      let opensBetween = 0;
      let m: RegExpExecArray | null;
      while ((m = openTagRe.exec(html)) !== null && m.index < nextClose) {
        // Self-close in between counts as 0 net depth — but our simple
        // tokeniser treats them the same; tests don't hit nested self-close
        // for the same name.
        opensBetween += 1;
      }
      depth += opensBetween - 1;
      if (depth === 0) {
        closeIdx = nextClose;
        break;
      }
      cursor = nextClose + closeTag.length;
    }
    if (closeIdx === -1) {
      // No matching close tag — push as leaf and advance past the open tag.
      children.push(el);
      i = tagEnd + 1;
      continue;
    }
    const inner = html.slice(tagEnd + 1, closeIdx);
    el.children = parseTopLevelChildren(inner);
    children.push(el);
    i = closeIdx + closeTag.length;
  }
  return children;
}

function findElement(
  root: FakeElement,
  predicate: (el: FakeElement) => boolean,
): FakeElement | null {
  if (predicate(root)) {
    return root;
  }
  for (const child of root.children) {
    const hit = findElement(child, predicate);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function findAll(
  root: FakeElement,
  predicate: (el: FakeElement) => boolean,
): FakeElement[] {
  const hits: FakeElement[] = [];
  const walk = (el: FakeElement) => {
    if (predicate(el)) {
      hits.push(el);
    }
    for (const child of el.children) {
      walk(child);
    }
  };
  walk(root);
  return hits;
}

const MATH_NS =
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

function mathRun(overrides: Partial<MathRun>): MathRun {
  return {
    kind: "math",
    display: "inline",
    ommlXml: `<m:oMath ${MATH_NS}><m:r><m:t>x</m:t></m:r></m:oMath>`,
    plainText: "x",
    fontFamily: "Cambria Math",
    fontSize: 12,
    italic: true,
    ...overrides,
  };
}

function renderMathRunOnce(run: MathRun): FakeElement {
  const block = {
    kind: "paragraph",
    runs: [run],
    attrs: {},
    styleId: undefined,
  } as unknown as Parameters<typeof renderLine>[0];

  const line = {
    fromRun: 0,
    toRun: 0,
    fromChar: 0,
    toChar: 1,
    lineHeight: 16,
    maxAscent: 12,
    maxDescent: 4,
    maxImageHeightPx: 0,
  } as unknown as Parameters<typeof renderLine>[1];

  return renderLine(block, line, "left", fakeDocument, {
    availableWidth: 500,
    isLastLine: true,
    isFirstLine: true,
    paragraphEndsWithLineBreak: false,
  }) as unknown as FakeElement;
}

describe("painter — OMML math run", () => {
  test("renders an inline `<math>` element with the MathML namespace", () => {
    const line = renderMathRunOnce(
      mathRun({
        ommlXml: `<m:oMath ${MATH_NS}><m:r><m:t>a+b</m:t></m:r></m:oMath>`,
        plainText: "a+b",
      }),
    );

    const host = findElement(line, (el) =>
      el.className.includes("docx-math-inline"),
    );
    expect(host).not.toBeNull();
    expect(host?.dataset["ommlRender"]).toBe("mathml");
    // `innerHTML` carries the MathML root element.
    expect(host?.innerHTML).toContain(
      'xmlns="http://www.w3.org/1998/Math/MathML"',
    );
    expect(host?.innerHTML).toContain("<mi>a</mi>");
    expect(host?.innerHTML).toContain("<mo>+</mo>");
    expect(host?.innerHTML).toContain("<mi>b</mi>");
  });

  test("marks block math with display=block class + dataset flag", () => {
    const line = renderMathRunOnce(
      mathRun({
        display: "block",
        ommlXml: `<m:oMathPara ${MATH_NS}><m:oMath><m:r><m:t>n</m:t></m:r></m:oMath></m:oMathPara>`,
        plainText: "n",
      }),
    );

    const host = findElement(line, (el) =>
      el.className.includes("docx-math-block"),
    );
    expect(host).not.toBeNull();
    expect(host?.dataset["display"]).toBe("block");
    expect(host?.innerHTML).toContain('display="block"');
  });

  test("falls back to italic plain-text span when OMML XML is malformed", () => {
    const line = renderMathRunOnce(
      mathRun({
        ommlXml: "<not-actually-omml>",
        plainText: "broken",
      }),
    );

    const fallback = findElement(line, (el) =>
      el.className.includes("docx-math-fallback"),
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.dataset["ommlRender"]).toBe("fallback");
    expect(fallback?.dataset["ommlRenderError"]).toBe("1");
    expect(fallback?.textContent).toBe("broken");
  });

  test("falls back when OMML element parses but has no math children", () => {
    const line = renderMathRunOnce(
      mathRun({
        ommlXml: `<m:oMath ${MATH_NS}/>`,
        plainText: "empty",
      }),
    );

    const fallback = findElement(line, (el) =>
      el.className.includes("docx-math-fallback"),
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe("empty");
  });

  test("sets alttext on the <math> root for screen readers", () => {
    const line = renderMathRunOnce(
      mathRun({
        ommlXml: `<m:oMath ${MATH_NS}><m:r><m:t>z</m:t></m:r></m:oMath>`,
        plainText: "the variable z",
      }),
    );

    const mathEl = findElement(line, (el) => el.tagName === "MATH");
    expect(mathEl).not.toBeNull();
    expect(mathEl?.getAttribute("alttext")).toBe("the variable z");
  });

  test("threads PM anchors onto MathML and fallback hosts", () => {
    const mathLine = renderMathRunOnce(
      mathRun({
        ommlXml: `<m:oMath ${MATH_NS}><m:r><m:t>q</m:t></m:r></m:oMath>`,
        pmStart: 4,
        pmEnd: 5,
      }),
    );
    const mathHost = findElement(mathLine, (el) =>
      el.className.includes("docx-math-inline"),
    );

    const fallbackLine = renderMathRunOnce(
      mathRun({
        ommlXml: "<not-actually-omml>",
        plainText: "broken",
        pmStart: 8,
        pmEnd: 9,
      }),
    );
    const fallbackHost = findElement(fallbackLine, (el) =>
      el.className.includes("docx-math-fallback"),
    );

    expect(mathHost?.dataset["pmStart"]).toBe("4");
    expect(mathHost?.dataset["pmEnd"]).toBe("5");
    expect(fallbackHost?.dataset["pmStart"]).toBe("8");
    expect(fallbackHost?.dataset["pmEnd"]).toBe("9");
  });

  test("renders the same MathML when the same OMML is rendered twice", () => {
    const run = mathRun({
      ommlXml: `<m:oMath ${MATH_NS}><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>`,
      plainText: "1/2",
    });
    const first = renderMathRunOnce(run);
    const second = renderMathRunOnce(run);
    const a = findElement(first, (el) => el.className.includes("docx-math"));
    const b = findElement(second, (el) => el.className.includes("docx-math"));
    expect(a?.innerHTML).toBe(b?.innerHTML ?? "");
    expect(a?.innerHTML).toContain("<mfrac>");
  });

  test("does not emit OMML property elements into the MathML tree", () => {
    const line = renderMathRunOnce(
      mathRun({
        ommlXml: `<m:oMath ${MATH_NS}><m:r><m:rPr><m:nor/></m:rPr><m:t>k</m:t></m:r></m:oMath>`,
        plainText: "k",
      }),
    );
    const host = findElement(line, (el) => el.className.includes("docx-math"));
    expect(host?.innerHTML).not.toContain("rPr");
    // The plain text k still made it through.
    expect(host?.innerHTML).toContain("<mi>k</mi>");
  });

  test("only one `<math>` root per inline run", () => {
    const line = renderMathRunOnce(
      mathRun({
        ommlXml: `<m:oMath ${MATH_NS}><m:r><m:t>q</m:t></m:r></m:oMath>`,
        plainText: "q",
      }),
    );
    const mathRoots = findAll(line, (el) => el.tagName === "MATH");
    expect(mathRoots.length).toBe(1);
  });

  test("right tabs reserve width for following math runs", () => {
    const block = {
      kind: "paragraph",
      runs: [
        { kind: "tab" },
        mathRun({
          plainText: "ABCDE",
          ommlXml: `<m:oMath ${MATH_NS}><m:r><m:t>ABCDE</m:t></m:r></m:oMath>`,
        }),
      ],
      attrs: {},
      styleId: undefined,
    } as unknown as Parameters<typeof renderLine>[0];

    const line = {
      fromRun: 0,
      toRun: 1,
      fromChar: 0,
      toChar: 1,
      lineHeight: 16,
      maxAscent: 12,
      maxDescent: 4,
      maxImageHeightPx: 0,
    } as unknown as Parameters<typeof renderLine>[1];

    const rendered = renderLine(block, line, "left", fakeDocument, {
      availableWidth: 300,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops: [{ val: "end", pos: 4500 }],
    }) as unknown as FakeElement;

    const tab = findElement(rendered, (el) =>
      el.className.includes("layout-run-tab"),
    );
    expect(tab?.style.width).toBe("265px");
  });
});
