import { describe, expect, test } from "bun:test";

import { parseFieldInstruction } from "../docx/fieldParser";
import { evaluateField, evaluateFieldInstruction } from "./evaluateField";
import type { FieldContext } from "./fieldContext";

const baseContext = (overrides: Partial<FieldContext> = {}): FieldContext => ({
  pageNumber: 3,
  totalPages: 12,
  sectionPages: 5,
  bookmarkPages: new Map(),
  bookmarkText: new Map(),
  seqValues: new Map(),
  // Fixed clock so DATE/TIME assertions are deterministic.
  now: new Date(2026, 5, 8, 14, 30, 0), // 2026-06-08 14:30
  ...overrides,
});

const evalInstr = (
  instruction: string,
  ctx: FieldContext,
  instanceId?: number,
) =>
  evaluateField(parseFieldInstruction(instruction), ctx, {
    fallback: "FB",
    ...(instanceId === undefined ? {} : { instanceId }),
  });

describe("evaluateField page-number family", () => {
  test("PAGE / NUMPAGES / SECTIONPAGES read their context counts", () => {
    const ctx = baseContext();
    expect(evalInstr("PAGE", ctx)).toBe("3");
    expect(evalInstr("NUMPAGES", ctx)).toBe("12");
    expect(evalInstr("SECTIONPAGES", ctx)).toBe("5");
  });

  test("locked fields preserve their cached fallback", () => {
    const ctx = baseContext();
    expect(
      evaluateField(parseFieldInstruction("PAGEREF _Ref1"), ctx, {
        fallback: "cached",
        locked: true,
      }),
    ).toBe("cached");
  });

  test("numeric format switches apply", () => {
    const ctx = baseContext();
    expect(evalInstr("PAGE \\* ROMAN", ctx)).toBe("III");
    expect(evalInstr("PAGE \\* ALPHABETIC", ctx)).toBe("C");
    expect(evalInstr("NUMPAGES \\* MERGEFORMAT", ctx)).toBe("12");
  });
});

describe("evaluateField references", () => {
  test("PAGEREF resolves a bookmark to its page, formatted", () => {
    const ctx = baseContext({ bookmarkPages: new Map([["_Ref1", 7]]) });
    expect(evalInstr("PAGEREF _Ref1 \\h", ctx)).toBe("7");
    expect(evalInstr("PAGEREF _Ref1 \\* ROMAN", ctx)).toBe("VII");
  });

  test("PAGEREF position switches preserve the cached result", () => {
    const ctx = baseContext({ bookmarkPages: new Map([["_Ref1", 7]]) });
    expect(evalInstr("PAGEREF _Ref1 \\p", ctx)).toBe("FB");
  });

  test("REF resolves a bookmark to its text", () => {
    const ctx = baseContext({
      bookmarkText: new Map([["_Ref1", "Schedule A"]]),
    });
    expect(evalInstr("REF _Ref1", ctx)).toBe("Schedule A");
  });

  test("REF numbering switches preserve the cached result", () => {
    const ctx = baseContext({
      bookmarkText: new Map([["_Ref1", "1.2 Definitions"]]),
    });
    expect(evalInstr("REF _Ref1 \\r", ctx)).toBe("FB");
    expect(evalInstr("REF _Ref1 \\n", ctx)).toBe("FB");
    expect(evalInstr("REF _Ref1 \\w", ctx)).toBe("FB");
  });

  test("unresolved references fall back", () => {
    const ctx = baseContext();
    expect(evalInstr("PAGEREF _Missing \\h", ctx)).toBe("FB");
    expect(evalInstr("REF _Missing", ctx)).toBe("FB");
  });
});

describe("evaluateField SEQ", () => {
  test("looks up the precomputed value by instance id and formats it", () => {
    const ctx = baseContext({ seqValues: new Map([[42, 4]]) });
    expect(evalInstr("SEQ Figure", ctx, 42)).toBe("4");
    expect(evalInstr("SEQ Figure \\* ROMAN", ctx, 42)).toBe("IV");
  });

  test("hidden SEQ fields preserve the cached result", () => {
    const ctx = baseContext({ seqValues: new Map([[42, 4]]) });
    expect(evalInstr("SEQ Figure \\h", ctx, 42)).toBe("FB");
  });

  test("falls back when no precomputed value exists for the instance", () => {
    const ctx = baseContext();
    expect(evalInstr("SEQ Figure", ctx, 99)).toBe("FB");
  });
});

describe("evaluateField dates and unsupported types", () => {
  test("DATE honours the \\@ format switch against the context clock", () => {
    const ctx = baseContext();
    expect(evalInstr('DATE \\@ "yyyy-MM-dd"', ctx)).toBe("2026-06-08");
  });

  test("DATE/TIME pictures do not re-tokenize formatted literals", () => {
    const ctx = baseContext();
    expect(evalInstr('TIME \\@ "h:mm AM/PM"', ctx)).toBe("2:30 PM");
    expect(evalInstr('DATE \\@ "dddd, MMMM d, yyyy"', ctx)).toBe(
      "Monday, June 8, 2026",
    );
  });

  test("DATE \\* MERGEFORMAT (no date picture) uses the locale date, not the switch", () => {
    const ctx = baseContext();
    // \* is a general format switch, not a date picture: must fall back to the
    // locale date instead of formatting the literal "MERGEFORMAT".
    expect(evalInstr("DATE \\* MERGEFORMAT", ctx)).toBe(
      ctx.now.toLocaleDateString(),
    );
  });

  test("document metadata date fields preserve cached fallback values", () => {
    const ctx = baseContext();
    expect(evalInstr('CREATEDATE \\@ "yyyy-MM-dd"', ctx)).toBe("FB");
    expect(evalInstr('SAVEDATE \\@ "yyyy-MM-dd"', ctx)).toBe("FB");
    expect(evalInstr('PRINTDATE \\@ "yyyy-MM-dd"', ctx)).toBe("FB");
  });

  test("unsupported field types return the fallback", () => {
    const ctx = baseContext();
    expect(evalInstr("MERGEFIELD client_name", ctx)).toBe("FB");
    expect(evalInstr('TOC \\o "1-3"', ctx)).toBe("FB");
  });

  test("evaluateFieldInstruction parses then evaluates", () => {
    const ctx = baseContext();
    expect(evaluateFieldInstruction("PAGE", ctx)).toBe("3");
  });
});
