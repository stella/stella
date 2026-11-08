import { describe, expect, test } from "bun:test";

import { docketRegisterPattern } from "@/api/lib/case-law/decision-search-metadata-sql";

type Filter = Parameters<typeof docketRegisterPattern>[0];

const matches = (filter: Filter, docket: string): boolean =>
  new RegExp(docketRegisterPattern(filter), "iu").test(docket);

describe("docketRegisterPattern", () => {
  test.each([
    "21 Cdo 641/2018",
    "22 Cdo 120/2026- I.",
    "6Cdo/163/2012",
    "21 CDO 641/2018",
  ])("Cdo keeps %s", (docket) => {
    expect(matches({ docketRegisters: ["Cdo"] }, docket)).toBe(true);
  });

  test.each(["6 Tdo 1343/2021", "21 Cdon 12/2020", "III.ÚS 336/96", "C-51/17"])(
    "Cdo leaves out %s",
    (docket) => {
      expect(matches({ docketRegisters: ["Cdo"] }, docket)).toBe(false);
    },
  );

  test("lists any of several registers", () => {
    const filter = { docketRegisters: ["Cdo", "Odo"] };
    expect(matches(filter, "29 Odo 123/2005")).toBe(true);
    expect(matches(filter, "8 Tdo 1406/2020")).toBe(false);
  });

  test("a senate alone matches its number whole, under any register", () => {
    expect(matches({ senate: 21 }, "21 Cdo 1/2020")).toBe(true);
    expect(matches({ senate: 21 }, "21 Tdo 1/2020")).toBe(true);
    expect(matches({ senate: 21 }, "2 Cdo 1/2020")).toBe(false);
    expect(matches({ senate: 2 }, "21 Cdo 1/2020")).toBe(false);
  });

  test("senate and register narrow together", () => {
    const filter = { docketRegisters: ["Cdo"], senate: 21 };
    expect(matches(filter, "21 Cdo 1/2020")).toBe(true);
    expect(matches(filter, "22 Cdo 1/2020")).toBe(false);
  });

  test("a register is matched literally", () => {
    expect(matches({ docketRegisters: ["C.o"] }, "21 Cdo 1/2020")).toBe(false);
  });
});
