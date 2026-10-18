import { describe, expect, test } from "bun:test";

import { isCourtCode, resolveCourtCode } from "./courts.js";

describe("resolveCourtCode", () => {
  const courtMap = {
    KSSCEUL: "Krajský soud Ústí nad Labem",
    MSPHAAB: "Městský soud v Praze",
    OSPHA09: "Obvodní soud Praha 9",
    OSSCEDC: "Okresní soud Děčín",
    OSSTCME: "Okresní soud Mělník",
  };

  test("matches diacritics-insensitive court names", () => {
    expect(resolveCourtCode("melnik", courtMap)).toBe("OSSTCME");
  });

  test("matches common shorthand with code prefixes", () => {
    expect(resolveCourtCode("OS Decin", courtMap)).toBe("OSSCEDC");
    expect(resolveCourtCode("decin os", courtMap)).toBe("OSSCEDC");
    expect(resolveCourtCode("ms praha", courtMap)).toBe("MSPHAAB");
  });

  test("matches short city district queries", () => {
    expect(resolveCourtCode("praha 9", courtMap)).toBe("OSPHA09");
  });

  test("returns null for unknown names", () => {
    expect(resolveCourtCode("neexistujici soud", courtMap)).toBeNull();
  });

  test("returns null for generic-only court queries", () => {
    expect(resolveCourtCode("okresni soud", courtMap)).toBeNull();
    expect(resolveCourtCode("soud", courtMap)).toBeNull();
  });

  test("does not misclassify plain city names as explicit court codes", () => {
    expect(isCourtCode("melnik")).toBe(false);
    expect(isCourtCode("decin")).toBe(false);
    expect(isCourtCode("OSSCEDC")).toBe(true);
    expect(isCourtCode("OSPHA09")).toBe(true);
    expect(isCourtCode("NS")).toBe(true);
  });
});
