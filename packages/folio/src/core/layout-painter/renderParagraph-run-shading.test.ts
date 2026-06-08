// eigenpal #722 (#712) — a run carrying resolved shading (w:shd background)
// paints as backgroundColor, exactly like a highlight. An explicit highlight
// wins over shading on the same run.

import { describe, expect, test } from "bun:test";

import type {
  MeasuredLine,
  ParagraphBlock,
  TextRun,
} from "../layout-engine/types";
import { renderLine } from "./renderParagraph";

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

const line: MeasuredLine = {
  fromRun: 0,
  fromChar: 0,
  toRun: 0,
  toChar: 7,
  width: 50,
  ascent: 10,
  descent: 2,
  lineHeight: 12,
};

function backgroundOf(run: TextRun): string | undefined {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id: "p1",
    runs: [run],
  };
  const lineEl = renderLine(block, line, undefined, fakeDocument);
  const textEl = lineEl.children[0] as HTMLElement | undefined;
  return textEl?.style.backgroundColor;
}

// Test fixtures use literal colors to assert what the painter paints.
/* eslint-disable no-inline-style-colors/no-inline-style-colors */
describe("renderLine run shading", () => {
  test("paints a shaded run's background", () => {
    expect(
      backgroundOf({ kind: "text", text: "Shaded", shading: "#FFFF00" }),
    ).toBe("#FFFF00");
  });

  test("an explicit highlight wins over shading on the same run", () => {
    expect(
      backgroundOf({
        kind: "text",
        text: "Both",
        highlight: "#00FF00",
        shading: "#FFFF00",
      }),
    ).toBe("#00FF00");
  });

  test("a run with neither highlight nor shading has no background", () => {
    expect(backgroundOf({ kind: "text", text: "Plain" })).toBeFalsy();
  });
});
