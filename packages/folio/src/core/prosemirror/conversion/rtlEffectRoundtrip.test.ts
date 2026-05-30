// eigenpal #424 (w:rtl gap 10 / w:effect gap 11) — round-trip the per-run
// direction and animation hints through the ProseMirror schema.

import { describe, expect, test } from "bun:test";

import type {
  Document,
  Paragraph,
  Run,
  TextEffect,
} from "../../types/document";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const runText = (text: string, formatting?: Run["formatting"]): Run => {
  const run: Run = {
    type: "run",
    content: [{ type: "text", text }],
  };
  if (formatting) {
    run.formatting = formatting;
  }
  return run;
};

const wrap = (...runs: Run[]): Document => ({
  package: {
    document: {
      content: [{ type: "paragraph", content: runs }],
    },
  },
});

const firstParagraph = (document: Document): Paragraph => {
  const block = document.package.document.content.at(0);
  if (block?.type !== "paragraph") {
    throw new Error("Expected first block to be a paragraph");
  }
  return block;
};

const findRun = (paragraph: Paragraph, text: string): Run => {
  for (const content of paragraph.content) {
    if (content.type !== "run") {
      continue;
    }
    const concat = content.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (concat === text) {
      return content;
    }
  }
  throw new Error(`Expected run with text ${text}`);
};

describe("RTL mark schema registration", () => {
  test("schema includes the rtl mark", () => {
    expect(schema.marks["rtl"]).toBeDefined();
  });

  test("schema includes the textEffect mark", () => {
    expect(schema.marks["textEffect"]).toBeDefined();
  });
});

describe("rtl mark round-trip through ProseMirror", () => {
  test("preserves rtl=true on a run", () => {
    const input = wrap(runText("שלום", { rtl: true }));
    const pmDoc = toProseDoc(input);
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "שלום");
    expect(run.formatting?.rtl).toBe(true);
  });

  test("preserves rtl=false override on a run", () => {
    // An explicit <w:rtl w:val="0"/> override (rtl=false) must survive the
    // PM round-trip; otherwise it would silently re-enable inherited RTL.
    const input = wrap(runText("plain", { rtl: false }));
    const pmDoc = toProseDoc(input);
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "plain");
    expect(run.formatting?.rtl).toBe(false);
  });

  test("rtl mark renders with dir=rtl on the span", () => {
    const rtlType = schema.marks["rtl"];
    if (!rtlType) {
      throw new Error("expected rtl mark");
    }
    const mark = rtlType.create();
    const spec = rtlType.spec.toDOM?.(mark, true);
    expect(spec).toBeDefined();
    // Expect a span element with dir="rtl"
    const [tag, attrs] = spec as [string, Record<string, string>, number];
    expect(tag).toBe("span");
    expect(attrs["dir"]).toBe("rtl");
  });
});

describe("textEffect mark round-trip through ProseMirror", () => {
  const variants: Exclude<TextEffect, "none">[] = [
    "blinkBackground",
    "lights",
    "antsBlack",
    "antsRed",
    "shimmer",
    "sparkle",
  ];

  for (const variant of variants) {
    test(`preserves effect=${variant} on a run`, () => {
      const input = wrap(runText("animated", { effect: variant }));
      const pmDoc = toProseDoc(input);
      const out = fromProseDoc(pmDoc, input);
      const run = findRun(firstParagraph(out), "animated");
      expect(run.formatting?.effect).toBe(variant);
    });

    test(`textEffect mark emits docx-text-effect-${variant} class`, () => {
      const effectType = schema.marks["textEffect"];
      if (!effectType) {
        throw new Error("expected textEffect mark");
      }
      const mark = effectType.create({ effect: variant });
      const spec = effectType.spec.toDOM?.(mark, true);
      expect(spec).toBeDefined();
      const [tag, attrs] = spec as [string, Record<string, string>, number];
      expect(tag).toBe("span");
      expect(attrs["class"]).toContain(`docx-text-effect-${variant}`);
      expect(attrs["data-effect"]).toBe(variant);
    });
  }

  test("effect=none does not produce a textEffect mark", () => {
    const input = wrap(runText("plain", { effect: "none" }));
    const pmDoc = toProseDoc(input);
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "plain");
    // round-trip should not have the textEffect mark and the resulting
    // formatting.effect should be undefined (the "none" sentinel is dropped).
    expect(run.formatting?.effect).toBeUndefined();
  });

  test("parseDOM rejects spans without a recognised data-effect", () => {
    const effectType = schema.marks["textEffect"];
    if (!effectType) {
      throw new Error("expected textEffect mark");
    }
    const parseRules = effectType.spec.parseDOM ?? [];
    expect(parseRules.length).toBeGreaterThan(0);
    const rule = parseRules[0];
    if (!rule || typeof rule.getAttrs !== "function") {
      throw new Error("expected getAttrs predicate on textEffect parseDOM");
    }
    // Stub DOM element exposing the single accessor the predicate relies on.
    // The first stub returns null for every attribute, standing in for a span
    // pasted without a textEffect marker.
    const fakeDom = { getAttribute: (_name: string) => null };
    // SAFETY: getAttrs only calls `getAttribute("data-effect")`; the cast
    // keeps the test free of jsdom.
    const result = rule.getAttrs(fakeDom as unknown as HTMLElement);
    expect(result).toBe(false);

    const taggedDom = {
      getAttribute: (name: string) =>
        name === "data-effect" ? "shimmer" : null,
    };
    const tagged = rule.getAttrs(taggedDom as unknown as HTMLElement);
    expect(tagged).toEqual({ effect: "shimmer" });
  });
});

describe("rtl + textEffect round-trip combined", () => {
  test("preserves both marks together", () => {
    const input = wrap(
      runText("mixed", { rtl: true, effect: "shimmer", bold: true }),
    );
    const pmDoc = toProseDoc(input);
    const out = fromProseDoc(pmDoc, input);
    const run = findRun(firstParagraph(out), "mixed");
    expect(run.formatting?.rtl).toBe(true);
    expect(run.formatting?.effect).toBe("shimmer");
    expect(run.formatting?.bold).toBe(true);
  });
});
