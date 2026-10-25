import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { reflowPrintedText } from "./hard-wrapped-lines";

const MARGIN = 66;
const INDENT = "     ";

/** Pad a line to the margin the way a typewriter justified it. */
const justify = (words: readonly string[], indent: string): string => {
  const gaps = words.length - 1;
  const spare = MARGIN - indent.length - words.join(" ").length;
  return (
    indent +
    words
      .map((word, index) =>
        index === gaps
          ? word
          : `${word}${" ".repeat(1 + Math.floor(spare / gaps) + (index < spare % gaps ? 1 : 0))}`,
      )
      .join("")
  );
};

/** Typewriter wrap: words never split, justified lines, a first-line indent. */
const typeset = (words: readonly string[]): string[] => {
  const lines: string[][] = [];
  let line: string[] = [];
  for (const word of words) {
    const indent = lines.length === 0 ? INDENT.length : 0;
    if (line.length > 0 && indent + [...line, word].join(" ").length > MARGIN) {
      lines.push(line);
      line = [];
    }
    line.push(word);
  }
  return [
    ...lines.map((printed, index) =>
      justify(printed, index === 0 ? INDENT : ""),
    ),
    `${lines.length === 0 ? INDENT : ""}${line.join(" ")}`,
  ];
};

const word = fc.stringMatching(/^[a-zěščřžýáíéůú]{2,7}$/u);
const capitalised = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
/** One sentence: a capital, lowercase words, a full stop. */
const sentence = fc
  .array(word, { minLength: 40, maxLength: 80 })
  .map((words) => [
    capitalised(words[0] ?? "soud"),
    ...words.slice(1, -1),
    `${words.at(-1) ?? ""}.`,
  ]);

/**
 * A paragraph of a decision written on a computer: one line, a sentence or
 * a lead-in, of the same order of length as a typescript's lines.
 */
const ordinaryParagraph = fc
  .tuple(
    fc.array(word, { minLength: 4, maxLength: 16 }),
    fc.constantFrom(".", ".", ":"),
  )
  .map(([words, end]) => `${capitalised(words.join(" "))}${end}`)
  .filter((text) => text.length >= 40 && text.length <= 100);

describe("printed lines of a typescript", () => {
  test("wrapped at one margin are read back as the paragraphs printed", () => {
    assertProperty(
      "hard-wrapped paragraphs reflow to their text",
      fc.property(
        fc.array(sentence, { minLength: 2, maxLength: 6 }),
        (paragraphs) => {
          const printed = paragraphs.flatMap((words, index) => [
            ...(index === 0 ? [] : [""]),
            ...typeset(words),
          ]);
          const reflowed = reflowPrintedText(printed).filter(
            (line) => line !== "",
          );
          expect(reflowed).toEqual(paragraphs.map((words) => words.join(" ")));
        },
      ),
      { numRuns: 100 },
    );
  });

  test("of ordinary paragraphs of similar length stay as printed", () => {
    assertProperty(
      "sentence paragraphs are not a typescript",
      fc.property(
        fc.array(
          fc.tuple(ordinaryParagraph, fc.boolean(), fc.nat({ max: 3 })),
          { minLength: 1, maxLength: 40 },
        ),
        (paragraphs) => {
          const lines = paragraphs.flatMap(([text, blank, indent]) => [
            `${" ".repeat(indent)}${text}`,
            ...(blank ? [""] : []),
          ]);
          expect(reflowPrintedText(lines)).toEqual(
            lines.map((line) => line.trim()),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("keep sentences of one width and the ruling after takto: apart", () => {
    const lines = [
      "Ústavní soud rozhodl o ústavní stížnosti takto:",
      "Ústavní stížnost se zamítá.",
      ...Array.from({ length: 4 }, () => [
        "Ústavní soud posoudil návrh a neshledal jej důvodným.",
        "Napadené rozhodnutí obecného soudu bylo řádně odůvodněno.",
      ]).flat(),
    ];
    expect(reflowPrintedText(lines)).toEqual(lines);
  });

  test("that do not share a margin stay as printed", () => {
    assertProperty(
      "unwrapped lines are kept",
      fc.property(
        fc.array(
          fc
            .integer({ min: 101, max: 400 })
            .map((length) => "x".repeat(length)),
          { minLength: 1, maxLength: 30 },
        ),
        (lines) => {
          expect(reflowPrintedText(lines)).toEqual(lines);
        },
      ),
      { numRuns: 50 },
    );
  });

  // I. ÚS 549/2000, verbatim: the margin broke a date after its day.
  test("keep a date broken at the margin in its sentence", () => {
    const paragraphs = reflowPrintedText([
      "     V odůvodnění rozsudku soud uvedl,  že se stěžovatelé domáhali",
      "zaplacení předmětné částky s poukazem na  to, že dohodou ze dne 7.",
      "10.  1991 M.  S. darovala  žalovanému chatu  ev. č.  612 v Praze 5",
      "- Stodůlky se stavební plochou č. 810  a zahradou č. 811 (dále jen",
      '"předmětné  nemovitosti") pod  podmínkou, že  žalovaný po 1prodeji',
      "těchto  nemovitostí  vyplatí  každému  stěžovateli z celkové ceny.",
      "Důvodem této smlouvy byla podle tvrzení stěžovatelů skutečnost, že",
      "stěžovatelé  byli devizovými  cizozemci, takže  jim M.  S. nemohla",
      "předmětné nemovitosti darovat.",
    ]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toContain("dohodou ze dne 7. 10. 1991 M. S.");
    expect(paragraphs[0]).toContain("v Praze 5 - Stodůlky");
    expect(paragraphs[0]).not.toMatch(/ {2}/u);
  });

  // Pl. ÚS 36/93, verbatim: a hyphenated word the decision spells whole
  // elsewhere, and a paragraph whose first line is indented with no blank
  // line before it.
  test("join a word the margin hyphenated, and break at an indent", () => {
    const paragraphs = reflowPrintedText([
      "u většiny  vědeckopedagogických  pracovníků  ke  změně  pracovních",
      "poměrů uzavřených  původně na neurčitou dobu  v pracovní poměry na",
      "dobu  určitou,   zpravidla  na  dobu  5   let.  Obě  výše  zmíněné",
      "skutečnosti  tedy de  facto anulovaly  záměry a  cíle, které  snad",
      "novela sledovala.",
      "     Na základě  výše uvedených argumentů  zastávám stanovisko, že",
      "článek II. zákona  č. 216/1993 Sb. je v  rozporu s ustanovením čl.",
      "1 Ústavy České republiky, s články 1, 3  odst. 1 a čl. 36 odst. 1,",
      "Listiny základních práv a svobod, jakož  i s Úmluvou č. 111 o dis-",
      "kriminaci  v  zaměstnání  a  povolání.  Demokratický  právní  stát",
      "založený na úctě k právům a svobodám člověka vylučuje, aby princip",
      "stejného zacházení v podmínkách  zákona byl porušován pro dosažení",
      "krátkodobých cílů.",
      "",
      "- s Úmluvou č. 111 o diskriminaci (zaměstnání a povolání),",
    ]);
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0]).toEndWith("cíle, které snad novela sledovala.");
    expect(paragraphs[1]).toStartWith(
      "Na základě výše uvedených argumentů zastávám stanovisko, že článek II. zákona č. 216/1993 Sb. je v rozporu s ustanovením čl. 1 Ústavy",
    );
    expect(paragraphs[1]).toContain(
      "s Úmluvou č. 111 o diskriminaci v zaměstnání a povolání.",
    );
  });

  describe("a hyphen at the margin", () => {
    /** A typescript paragraph whose second line ends on `last`. */
    const brokenAt = (last: string, next: string): string[] => [
      justify(
        ["Ústavní", "soud", "posoudil", "námitky", "stěžovatele", "ve", "věci"],
        INDENT,
      ),
      justify(["podle", "zákona", "o", "státní", "příslušnosti", last], ""),
      `${next} a neshledal je důvodnými, jak dále uvádí.`,
    ];
    const around = typeset(
      "Stěžovatel se domáhal zrušení rozhodnutí krajského soudu a tvrdil, že soud nevzal v úvahu jeho námitky ani důkazy, které navrhl, a že tím porušil jeho právo na spravedlivý proces podle čl. 36 odst. 1 Listiny základních práv a svobod, neboť jej zbavil možnosti vyjádřit se k provedeným důkazům a navrhnout důkazy vlastní.".split(
        " ",
      ),
    );
    const typescriptAround = (paragraph: readonly string[]): string[] => [
      ...paragraph,
      "",
      ...around,
      "",
      ...around,
    ];

    test("of a compound stays, with no space", () => {
      const [first] = reflowPrintedText(
        typescriptAround(brokenAt("česko-", "slovenské")),
      );
      expect(first).toContain("o státní příslušnosti česko-slovenské a");
    });

    test("of a compound the text spells elsewhere stays", () => {
      const [first] = reflowPrintedText([
        ...typescriptAround(brokenAt("vědecko-", "pedagogické")),
        "",
        "Jde o vědecko-pedagogické pracovníky.",
      ]);
      expect(first).toContain("příslušnosti vědecko-pedagogické a");
    });

    test("in a word the text spells whole elsewhere goes", () => {
      const [first] = reflowPrintedText([
        ...typescriptAround(brokenAt("stěžova-", "telovy")),
        "",
        "Ústavní soud námitky stěžovatelovy odmítl.",
      ]);
      expect(first).toContain("příslušnosti stěžovatelovy a");
    });

    test("marked as soft by the source goes", () => {
      const [first] = reflowPrintedText(
        typescriptAround(brokenAt("stěžova­", "telovy")),
      );
      expect(first).toContain("příslušnosti stěžovatelovy a");
    });
  });

  test("keep a suspended hyphen before a conjunction", () => {
    const [first] = reflowPrintedText([
      justify(
        ["Pracovní", "poměr", "učitelů", "se", "sjednává", "na", "dobu"],
        INDENT,
      ),
      justify(
        ["určitou,", "nejméně", "však", "na", "dobu", "dvou-", "nebo", "dvou-"],
        "",
      ),
      "a tříleté smlouvy podle zákoníku práce.",
      "",
      ...typeset(
        "Ústavní soud návrh skupiny poslanců zamítl a odůvodnil to tím, že se pro vyhovění návrhu v plénu nevyslovila potřebná většina devíti soudců, jak to vyžaduje ustanovení § 13 zákona o Ústavním soudu, a že rozhodnutí o zamítnutí návrhu proto nemohlo být jiné, než jaké plénum přijalo dne 17. května 1994.".split(
          " ",
        ),
      ),
    ]);
    expect(first).toBe(
      "Pracovní poměr učitelů se sjednává na dobu určitou, nejméně však na dobu dvou- nebo dvou- a tříleté smlouvy podle zákoníku práce.",
    );
  });

  // I. ÚS 2/93, verbatim: list items with a hanging indent.
  test("keep list items apart and their hanging lines with them", () => {
    expect(
      reflowPrintedText([
        'rozsudky  porušena  "svoboda  stěžovatelek  nebýt podroben nuceným',
        'pracím nebo službám"  ve smyslu čl. 9 odst.  1 Listiny, je zřejmé,',
        "že výklad  tohoto článku stěžovatelkami  nelze přijmout. Při  jeho",
        "interpretaci lze použít jako  pomocné hledisko ustanovení odstavce",
        "2 cit. článku, v němž se uvádí, že ust. odst. 1 se nevztahuje na:",
        "",
        "a)  práce  ukládané podle  zákona osobám  ve výkonu  trestu odnětí",
        "    svobody nebo osobám vykonávajícím jiný trest nahrazující trest",
        "    odnětí svobody,",
        "",
        "b)  vojenskou službu nebo jinou službu stanovenou zákonem na místo",
        "    povinné vojenské služby,",
        "",
        "d)  jednání uložené  zákonem pro ochranu života,  zdraví nebo práv",
        "    druhých.",
      ]).filter((line) => line !== ""),
    ).toEqual([
      'rozsudky porušena "svoboda stěžovatelek nebýt podroben nuceným pracím nebo službám" ve smyslu čl. 9 odst. 1 Listiny, je zřejmé, že výklad tohoto článku stěžovatelkami nelze přijmout. Při jeho interpretaci lze použít jako pomocné hledisko ustanovení odstavce 2 cit. článku, v němž se uvádí, že ust. odst. 1 se nevztahuje na:',
      "a) práce ukládané podle zákona osobám ve výkonu trestu odnětí svobody nebo osobám vykonávajícím jiný trest nahrazující trest odnětí svobody,",
      "b) vojenskou službu nebo jinou službu stanovenou zákonem na místo povinné vojenské služby,",
      "d) jednání uložené zákonem pro ochranu života, zdraví nebo práv druhých.",
    ]);
  });
});
