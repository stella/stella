import { describe, expect, test } from "bun:test";

import {
  applyLearnedFixChanges,
  LEARNED_FIX_LIMIT,
  type LearnedFix,
  type LearnedFixChange,
  learnedFixKey,
} from "./learned-fixes";

const corrected = (from: string, to: string): LearnedFixChange => ({
  type: "corrected",
  from,
  to,
});

const fix = (
  from: string,
  to: string,
  status: LearnedFix["status"] = "on",
  seen = 2,
): LearnedFix => ({ from, to, seen, status });

describe("applyLearnedFixChanges", () => {
  test("a correction seen twice the same way turns on", () => {
    const once = applyLearnedFixChanges([], [corrected("Hrubeš", "Hrubesch")]);
    expect(once).toEqual([fix("Hrubeš", "Hrubesch", "learning", 1)]);
    expect(
      applyLearnedFixChanges(once, [corrected("hrubeš", "Hrubesch")]),
    ).toEqual([fix("Hrubeš", "Hrubesch", "on", 2)]);
  });

  test("a correction made another way contradicts the fix for good", () => {
    const fixes = applyLearnedFixChanges(
      [fix("Hrubeš", "Hrubesch", "learning", 1)],
      [corrected("Hrubeš", "Hrubesh")],
    );
    expect(fixes).toEqual([fix("Hrubeš", "Hrubesch", "contradicted", 1)]);
    expect(
      applyLearnedFixChanges(fixes, [corrected("Hrubeš", "Hrubesch")]),
    ).toEqual([fix("Hrubeš", "Hrubesch", "contradicted", 2)]);
  });

  test("turning a fix's words back contradicts it, unless it is off", () => {
    expect(
      applyLearnedFixChanges(
        [fix("Hrubeš", "Hrubesch"), fix("Lorenc", "Lorentz", "off")],
        [corrected("Hrubesch", "Hrubeš"), corrected("Lorentz", "Lorenc")],
      ).map(({ from, status }) => [from, status]),
    ).toEqual([
      ["Hrubeš", "contradicted"],
      ["Lorenc", "off"],
      ["Hrubesch", "learning"],
      ["Lorentz", "learning"],
    ]);
  });

  test("a fix of case alone is learned, not taken for its own reversal", () => {
    const once = applyLearnedFixChanges(
      [],
      [corrected("Mckenzie", "McKenzie")],
    );
    expect(
      applyLearnedFixChanges(once, [corrected("Mckenzie", "McKenzie")]),
    ).toEqual([fix("Mckenzie", "McKenzie", "on", 2)]);
    expect(
      applyLearnedFixChanges(
        [fix("Mckenzie", "McKenzie")],
        [corrected("McKenzie", "Mckenzie")],
      ).at(0)?.status,
    ).toBe("contradicted");
  });

  test("words kept as dictated contradict their fix", () => {
    expect(
      applyLearnedFixChanges(
        [fix("Hrubeš", "Hrubesch"), fix("Lorenc", "Lorentz", "off")],
        [
          { type: "kept", from: "HRUBEŠ" },
          { type: "kept", from: "lorenc" },
        ],
      ),
    ).toEqual([
      fix("Hrubeš", "Hrubesch", "contradicted"),
      fix("Lorenc", "Lorentz", "off"),
    ]);
  });

  test("a taught fix is on at once and replaces what was learned", () => {
    expect(
      applyLearnedFixChanges(
        [fix("Hrubeš", "Hrubesh", "contradicted", 3), fix("Lorenc", "Lorentz")],
        [{ type: "taught", from: "hrubeš", to: "Hrubesch" }],
      ),
    ).toEqual([fix("Lorenc", "Lorentz"), fix("hrubeš", "Hrubesch", "on", 4)]);
  });

  test("a switch sets the status of a known fix and leaves others alone", () => {
    const fixes = [fix("Hrubeš", "Hrubesch"), fix("Lorenc", "Lorentz")];
    expect(
      applyLearnedFixChanges(fixes, [
        { type: "switched", from: "hrubeš", status: "off" },
        { type: "switched", from: "Novák", status: "on" },
      ]),
    ).toEqual([fix("Hrubeš", "Hrubesch", "off"), fix("Lorenc", "Lorentz")]);
  });

  test("past the limit the oldest unused fix goes first", () => {
    const full = Array.from({ length: LEARNED_FIX_LIMIT }, (_, index) =>
      fix(`slovo${String.fromCodePoint(97 + index)}`, "x", "on"),
    );
    const withLearning = [
      ...full.slice(0, 5),
      fix("rozpracovano", "rozpracováno", "learning", 1),
      ...full.slice(6),
    ];
    const next = applyLearnedFixChanges(withLearning, [
      corrected("nakonec", "na konec"),
    ]);
    expect(next).toHaveLength(LEARNED_FIX_LIMIT);
    expect(next.map(({ from }) => from)).not.toContain("rozpracovano");
    expect(next.at(-1)?.from).toBe("nakonec");
    const allOn = applyLearnedFixChanges(full, [
      { type: "taught", from: "posledni", to: "poslední" },
    ]);
    expect(allOn.at(0)?.from).toBe("slovob");
  });

  test("the same changes always give the same fixes", () => {
    const changes: LearnedFixChange[] = [
      corrected("Hrubeš", "Hrubesch"),
      { type: "kept", from: "Lorenc" },
      corrected("Hrubeš", "Hrubesch"),
      { type: "switched", from: "Hrubeš", status: "off" },
    ];
    const first = applyLearnedFixChanges([], changes);
    expect(applyLearnedFixChanges([], changes)).toEqual(first);
    expect(first).toEqual([fix("Hrubeš", "Hrubesch", "off", 2)]);
  });
});

describe("learnedFixKey", () => {
  test("compares case, apostrophes and spacing away", () => {
    expect(learnedFixKey(" O’Neill  Hall ")).toBe("o'neill hall");
  });
});
