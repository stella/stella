import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  alignAmendmentPoints,
  parseAmendmentInstruction,
} from "./amendment-instruction";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";

const point = (id: string, text: string) => ({
  id,
  text,
  article: "1",
  point: 1,
  workIdentifier: "89/2012 Sb.",
});

describe("amendment instruction targets", () => {
  test.each([
    {
      text: "V § 5 odst. 2 se slova „staré znění“ nahrazují slovy „nové znění“.",
      operation: "replace",
      section: 5,
      subsection: "2",
      letter: null,
      suffix: null,
    },
    {
      text: "§ 5 zní:",
      operation: "replace",
      section: 5,
      subsection: null,
      letter: null,
      suffix: null,
    },
    {
      text: "Za § 5 se vkládá nový § 5a.",
      operation: "insert",
      section: 5,
      subsection: null,
      letter: null,
      suffix: "a",
    },
    {
      text: "V § 1 se doplňuje písmeno l), které zní:",
      operation: "insert",
      section: 1,
      subsection: null,
      letter: "l",
      suffix: null,
    },
    {
      text: "V § 4 odst. 4 písmeno e) zní:",
      operation: "replace",
      section: 4,
      subsection: "4",
      letter: "e",
      suffix: null,
    },
    {
      text: "V § 8 odst. 1 písm. c) se slova „jde-li o zařízení“ zrušují.",
      operation: "delete",
      section: 8,
      subsection: "1",
      letter: "c",
      suffix: null,
    },
  ] as const)(
    "resolves the operation and target of $text",
    ({ text, operation, section, subsection, letter, suffix }) => {
      const parsed = parseAmendmentInstruction({ jurisdiction: "CZE", text });
      expect(parsed.status).toBe("parsed");
      if (parsed.status !== "parsed") {
        return;
      }
      expect(parsed.operations).toEqual([operation]);
      expect(parsed.targets).toHaveLength(1);
      expect(parsed.targets.at(0)?.section).toBe(section);
      expect(parsed.targets.at(0)?.sectionSuffix).toBe(suffix ?? null);
      expect(parsed.targets.at(0)?.subsection).toBe(subsection);
      expect(parsed.targets.at(0)?.letter).toBe(letter);
    },
  );

  test("inserted letter lists expand against their stated parent", () => {
    const parsed = parseAmendmentInstruction({
      jurisdiction: "CZE",
      text: "V § 2 se doplňují písmena c) a d), která znějí:",
    });
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") {
      return;
    }
    expect(parsed.targets.map((target) => target.letter)).toEqual(["c", "d"]);
    expect(parsed.targets.every((target) => target.section === 2)).toBe(true);
  });

  test("renumbering carries pre-amendment references to their introduced numbering", () => {
    const context = PROVISION_CITATION_GRAMMARS.CZE.parseReference("§ 5");
    expect(context).not.toBeNull();
    if (context === null) {
      return;
    }
    const parsed = parseAmendmentInstruction({
      jurisdiction: "CZE",
      text: "Dosavadní odstavce 3 a 4 se označují jako odstavce 4 a 5.",
      context,
    });
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") {
      return;
    }
    expect(
      parsed.renumbering.map(({ from, to }) => [
        from.subsection,
        to.subsection,
      ]),
    ).toEqual([
      ["3", "4"],
      ["4", "5"],
    ]);
    expect(parsed.targets.map((target) => target.subsection)).toEqual([
      "4",
      "5",
    ]);
  });

  test.each([
    "unrecognised text",
    "V § 5 se něco mění.",
    "V § 5 se slovo „bez konce nahrazuje slovem x.",
    "V § 1 se doplňuje písmeno l) a unknown",
    "V § 7 se dosavadní text označuje jako odstavec 1 a doplňuje se odstavec 2.",
  ])("retains an unsupported instruction %s", (text) => {
    expect(
      parseAmendmentInstruction({ jurisdiction: "CZE", text }).status,
    ).toBe("unsupported");
  });
  test("amendment insertions reject Unicode case-fold lookalikes", () => {
    assertProperty(
      "amendment insertions reject Unicode case-fold lookalikes",
      fc.property(fc.constantFrom("ſ", "K", "ı"), (letter) => {
        for (const text of [
          `Za § 5 se vkládá nový § 5${letter}.`,
          `V § 5 se doplňuje písmeno ${letter}).`,
          `V § 5${letter} se slovo „a“ zrušuje.`,
        ]) {
          expect(
            parseAmendmentInstruction({ text, jurisdiction: "CZE" }).status,
          ).toBe("unsupported");
        }
      }),
    );
  });

  test("renumbering without its section context is explicitly unsupported", () => {
    expect(
      parseAmendmentInstruction({
        jurisdiction: "CZE",
        text: "Dosavadní odstavce 3 a 4 se označují jako odstavce 4 a 5.",
      }),
    ).toEqual({ status: "unsupported", reason: "context_required" });
  });
});

describe("bill to enacted instruction alignment", () => {
  test("amendment display numbers never determine correspondence", () => {
    assertProperty(
      "amendment display numbers never determine correspondence",
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 101, max: 200 }),
        fc.integer({ min: 1, max: 999 }),
        (billNumber, enactedNumber, section) => {
          const text = `V § ${section} se slovo „původní“ nahrazuje slovem „nové“. `;
          const bill = {
            ...point("bill", `${billNumber}. ${text}`),
            point: billNumber,
          };
          const enacted = {
            ...point("enacted", `${enactedNumber}. ${text}`),
            point: enactedNumber,
          };
          const aligned = alignAmendmentPoints({
            enactedCoverage: "complete",
            jurisdiction: "CZE",
            bill: [bill],
            enacted: [enacted],
          });
          expect(aligned.at(0)?.status).toBe("aligned");
          const changed = alignAmendmentPoints({
            enactedCoverage: "complete",
            jurisdiction: "CZE",
            bill: [bill],
            enacted: [
              { ...enacted, text: enacted.text.replace("nové", "odlišné") },
            ],
          });
          expect(changed.at(0)?.status).toBe("not_in_enacted_text");
        },
      ),
    );
  });

  test("equally matching enacted instructions remain ambiguous", () => {
    const text = "V § 5 se slovo „a“ nahrazuje slovem „b“.";
    const aligned = alignAmendmentPoints({
      enactedCoverage: "complete",
      jurisdiction: "CZE",
      bill: [point("bill", text)],
      enacted: [point("one", text), point("two", text)],
    });
    expect(aligned.at(0)?.status).toBe("ambiguous");
  });
  test("a same-number instruction for another act cannot align", () => {
    const text = "V § 5 se slovo „a“ nahrazuje slovem „b“.";
    expect(
      alignAmendmentPoints({
        enactedCoverage: "complete",
        jurisdiction: "CZE",
        bill: [point("bill", text)],
        enacted: [
          { ...point("enacted", text), workIdentifier: "150/2002 Sb." },
        ],
      }).at(0)?.status,
    ).toBe("not_in_enacted_text");
  });
  test("unparsed enacted instructions prevent a claim of absence", () => {
    const text = "V § 5 se slovo „a“ nahrazuje slovem „b“.";
    expect(
      alignAmendmentPoints({
        enactedCoverage: "complete",
        jurisdiction: "CZE",
        bill: [point("bill", text)],
        enacted: [point("unknown", "K příloze")],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
  });
  test("quote whitespace remains part of the instruction signature", () => {
    const bill = point("bill", "V § 5 se slova „a  b“ nahrazují slovy „c“.");
    const enacted = point(
      "enacted",
      "V § 5 se slova „a b“ nahrazují slovy „c“.",
    );
    expect(
      alignAmendmentPoints({
        enactedCoverage: "complete",
        jurisdiction: "CZE",
        bill: [bill],
        enacted: [enacted],
      }).at(0)?.status,
    ).toBe("not_in_enacted_text");
  });
  test("partial enacted inputs cannot establish a unique match or absence", () => {
    const bill = point("bill", "V § 5 se slovo „a“ nahrazuje slovem „b“.");
    for (const enacted of [[], [{ ...bill, id: "enacted" }]]) {
      expect(
        alignAmendmentPoints({
          enactedCoverage: "partial",
          jurisdiction: "CZE",
          bill: [bill],
          enacted,
        }).at(0)?.status,
      ).toBe("unresolved_anchor");
    }
  });
  test("an invalid enacted work identifier prevents a claim of absence", () => {
    const bill = point("bill", "V § 5 se slovo „a“ nahrazuje slovem „b“.");
    expect(
      alignAmendmentPoints({
        enactedCoverage: "complete",
        jurisdiction: "CZE",
        bill: [bill],
        enacted: [{ ...bill, id: "invalid", workIdentifier: "unknown act" }],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
  });

  test("unparseable bill instructions remain unresolved", () => {
    expect(
      alignAmendmentPoints({
        enactedCoverage: "complete",
        jurisdiction: "CZE",
        bill: [point("bill", "K příloze")],
        enacted: [],
      }).at(0)?.status,
    ).toBe("unresolved_anchor");
  });
});
