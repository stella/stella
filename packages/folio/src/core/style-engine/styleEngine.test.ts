/**
 * Tests for the style engine.
 *
 * Covers public API surface, cascade-order parity with the underlying
 * resolver, and cache semantics (hits, misses, invalidation, toggle).
 */

import { describe, expect, test } from "bun:test";

import type { StyleDefinitions } from "../types/document";
import { createStyleEngine } from "./styleEngine";

const normalOnly: StyleDefinitions = {
  styles: [
    {
      styleId: "Normal",
      type: "paragraph",
      name: "Normal",
      default: true,
      pPr: { spaceAfter: 200 },
      rPr: { fontSize: 22 },
    },
  ],
};

const withHeading: StyleDefinitions = {
  styles: [
    {
      styleId: "Normal",
      type: "paragraph",
      name: "Normal",
      default: true,
      rPr: { fontSize: 22 },
    },
    {
      styleId: "Heading1",
      type: "paragraph",
      name: "Heading 1",
      basedOn: "Normal",
      pPr: { alignment: "center" },
      rPr: { fontSize: 36, bold: true },
    },
  ],
};

const withCharacter: StyleDefinitions = {
  docDefaults: {
    rPr: { fontFamily: { ascii: "Calibri", hAnsi: "Calibri" } },
  },
  styles: [
    {
      styleId: "Emphasis",
      type: "character",
      name: "Emphasis",
      rPr: { italic: true },
    },
  ],
};

describe("styleEngine — public API", () => {
  test("createStyleEngine accepts undefined definitions", () => {
    const engine = createStyleEngine(undefined);
    expect(engine.hasStyle("Normal")).toBe(false);
    expect(engine.getStyle("Normal")).toBeUndefined();
  });

  test("exposes pass-through accessors", () => {
    const engine = createStyleEngine(withHeading);
    expect(engine.hasStyle("Heading1")).toBe(true);
    expect(engine.getStyle("Heading1")?.name).toBe("Heading 1");
    expect(engine.getDefaultParagraphStyle()?.styleId).toBe("Normal");
    expect(engine.getDefaultCharacterStyle()).toBeUndefined();
    expect(engine.getDefaultTableStyle()).toBeUndefined();
    expect(
      engine
        .getParagraphStyles()
        .map((s) => s.styleId)
        .sort(),
    ).toEqual(["Heading1", "Normal"]);
    expect(engine.getTableStyles()).toEqual([]);
  });

  test("getDocDefaults reflects underlying definitions", () => {
    const engine = createStyleEngine(withCharacter);
    expect(engine.getDocDefaults()?.rPr?.fontFamily?.ascii).toBe("Calibri");
  });
});

describe("styleEngine — cascade resolution", () => {
  test("resolveParagraphStyle applies basedOn chain", () => {
    const engine = createStyleEngine(withHeading);
    const resolved = engine.resolveParagraphStyle("Heading1");
    expect(resolved.paragraphFormatting?.alignment).toBe("center");
    expect(resolved.runFormatting?.fontSize).toBe(36);
    expect(resolved.runFormatting?.bold).toBe(true);
  });

  test("resolveParagraphStyle falls back to default for unknown styleId", () => {
    const engine = createStyleEngine(normalOnly);
    const resolved = engine.resolveParagraphStyle("DoesNotExist");
    expect(resolved.paragraphFormatting?.spaceAfter).toBe(200);
    expect(resolved.runFormatting?.fontSize).toBe(22);
  });

  test("resolveParagraphStyle uses default when styleId is null", () => {
    const engine = createStyleEngine(normalOnly);
    const fromNull = engine.resolveParagraphStyle(null);
    const fromUndef = engine.resolveParagraphStyle(undefined);
    expect(fromNull.runFormatting?.fontSize).toBe(22);
    expect(fromUndef.runFormatting?.fontSize).toBe(22);
  });

  test("resolveRunStyle merges docDefaults under character style", () => {
    const engine = createStyleEngine(withCharacter);
    const resolved = engine.resolveRunStyle("Emphasis");
    expect(resolved?.italic).toBe(true);
    expect(resolved?.fontFamily?.ascii).toBe("Calibri");
  });

  test("resolveRunStyle returns undefined when nothing applies", () => {
    const engine = createStyleEngine({ styles: [] });
    expect(engine.resolveRunStyle(null)).toBeUndefined();
  });

  test("getRunStyleOwnProperties skips docDefaults", () => {
    const engine = createStyleEngine(withCharacter);
    const own = engine.getRunStyleOwnProperties("Emphasis");
    expect(own?.italic).toBe(true);
    // docDefault font intentionally NOT included
    expect(own?.fontFamily).toBeUndefined();
  });

  test("getRunStyleOwnProperties returns undefined for null styleId", () => {
    const engine = createStyleEngine(withCharacter);
    expect(engine.getRunStyleOwnProperties(null)).toBeUndefined();
  });
});

describe("styleEngine — cache semantics", () => {
  test("repeated resolveParagraphStyle calls hit the cache", () => {
    const engine = createStyleEngine(withHeading);
    engine.resolveParagraphStyle("Heading1");
    engine.resolveParagraphStyle("Heading1");
    engine.resolveParagraphStyle("Heading1");
    const stats = engine.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.size).toBe(1);
  });

  test("distinct styleIds occupy distinct cache slots", () => {
    const engine = createStyleEngine(withHeading);
    engine.resolveParagraphStyle("Heading1");
    engine.resolveParagraphStyle("Normal");
    expect(engine.stats().size).toBe(2);
  });

  test("null and undefined styleIds share the default cache slot", () => {
    const engine = createStyleEngine(normalOnly);
    engine.resolveParagraphStyle(null);
    engine.resolveParagraphStyle(undefined);
    const stats = engine.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  test("cache returns the same object reference on subsequent hits", () => {
    const engine = createStyleEngine(withHeading);
    const first = engine.resolveParagraphStyle("Heading1");
    const second = engine.resolveParagraphStyle("Heading1");
    expect(first).toBe(second);
  });

  test("cached result matches uncached result for parity", () => {
    const cached = createStyleEngine(withHeading);
    const uncached = createStyleEngine(withHeading, { cache: false });
    expect(cached.resolveParagraphStyle("Heading1")).toEqual(
      uncached.resolveParagraphStyle("Heading1"),
    );
    expect(cached.resolveRunStyle("Heading1")).toEqual(
      uncached.resolveRunStyle("Heading1"),
    );
  });

  test("invalidate clears every cache and resets counters", () => {
    const engine = createStyleEngine(withHeading);
    engine.resolveParagraphStyle("Heading1");
    engine.resolveRunStyle("Heading1");
    engine.getRunStyleOwnProperties("Heading1");
    expect(engine.stats().size).toBeGreaterThan(0);
    engine.invalidate();
    const after = engine.stats();
    expect(after.size).toBe(0);
    expect(after.hits).toBe(0);
    expect(after.misses).toBe(0);
  });

  test("cache:false disables memoization but preserves correctness", () => {
    const engine = createStyleEngine(withHeading, { cache: false });
    const first = engine.resolveParagraphStyle("Heading1");
    const second = engine.resolveParagraphStyle("Heading1");
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    const stats = engine.stats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(0);
    expect(stats.size).toBe(0);
  });

  test("resolveRunStyle cache stores undefined results", () => {
    const engine = createStyleEngine({ styles: [] });
    engine.resolveRunStyle("NoSuchStyle");
    engine.resolveRunStyle("NoSuchStyle");
    const stats = engine.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  test("getRunStyleOwnProperties is memoized independently", () => {
    const engine = createStyleEngine(withCharacter);
    engine.getRunStyleOwnProperties("Emphasis");
    engine.resolveRunStyle("Emphasis");
    engine.getRunStyleOwnProperties("Emphasis");
    const stats = engine.stats();
    // Two distinct caches populated once each, plus one repeat hit.
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.size).toBe(2);
  });
});

describe("styleEngine — ECMA-376 cascade precedence", () => {
  // Direct < named-style < default-of-type < docDefaults is the
  // *reverse* of precedence; the engine merges low→high so direct
  // overrides win at the call site (toProseDoc layers direct
  // formatting on top of the resolved style result).
  test("docDefaults are dominated by default-of-type style", () => {
    const defs: StyleDefinitions = {
      docDefaults: { rPr: { fontSize: 20 } },
      styles: [
        {
          styleId: "Normal",
          type: "paragraph",
          name: "Normal",
          default: true,
          rPr: { fontSize: 24 },
        },
      ],
    };
    const engine = createStyleEngine(defs);
    expect(engine.resolveParagraphStyle(null).runFormatting?.fontSize).toBe(24);
  });

  test("named style dominates default-of-type style", () => {
    const defs: StyleDefinitions = {
      styles: [
        {
          styleId: "Normal",
          type: "paragraph",
          name: "Normal",
          default: true,
          rPr: { fontSize: 22 },
        },
        {
          styleId: "Heading1",
          type: "paragraph",
          name: "Heading 1",
          basedOn: "Normal",
          rPr: { fontSize: 36 },
        },
      ],
    };
    const engine = createStyleEngine(defs);
    expect(
      engine.resolveParagraphStyle("Heading1").runFormatting?.fontSize,
    ).toBe(36);
  });

  test("character-style cascade layers docDefaults below own props", () => {
    const defs: StyleDefinitions = {
      docDefaults: { rPr: { fontSize: 22, bold: false } },
      styles: [
        {
          styleId: "Strong",
          type: "character",
          name: "Strong",
          rPr: { bold: true },
        },
      ],
    };
    const engine = createStyleEngine(defs);
    const resolved = engine.resolveRunStyle("Strong");
    expect(resolved?.bold).toBe(true);
    expect(resolved?.fontSize).toBe(22);
  });
});
