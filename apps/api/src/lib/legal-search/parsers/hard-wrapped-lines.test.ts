import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  LINE_JOINS,
  PDF_LINE_KIND,
  type PdfPrintedLine,
  readPdfLineJoins,
  reflowPrintedText,
} from "./hard-wrapped-lines";

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
const paragraphOfLength = (min: number, max: number) =>
  fc
    .tuple(
      fc.array(word, {
        minLength: Math.ceil(min / 9),
        maxLength: Math.floor(max / 3),
      }),
      fc.constantFrom(".", ".", ":"),
    )
    .map(([words, end]) => `${capitalised(words.join(" "))}${end}`)
    .filter((text) => text.length >= min && text.length <= max);
const ordinaryParagraph = paragraphOfLength(40, 100);

describe("printed lines of a typescript", () => {
  test("wrapped at one margin are read back as the paragraphs printed", () => {
    assertProperty(
      "wrapped at one margin are read back as the paragraphs printed",
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
      "of ordinary paragraphs of similar length stay as printed",
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
      "that do not share a margin stay as printed",
      fc.property(
        fc.array(paragraphOfLength(101, 400), { minLength: 1, maxLength: 30 }),
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

    test("of a compound stays when only a longer word shares its letters", () => {
      const [first] = reflowPrintedText([
        ...typescriptAround(brokenAt("česko-", "slovenský")),
        "",
        "Československo zaniklo.",
      ]);
      expect(first).toContain("o státní příslušnosti česko-slovenský a");
      expect(first).not.toContain("československý");
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

describe("PDF line joins", () => {
  const LEFT = 72;
  const RIGHT = 522;
  const HEIGHT = 12;
  const PITCH = 14;

  /** One body line on page 0, `row` lines down, starting at `x`. */
  const pdfLine = (text: string, row: number, x: number): PdfPrintedLine => ({
    kind: PDF_LINE_KIND.BODY,
    text,
    layout: {
      x,
      y: 700 - row * PITCH,
      height: HEIGHT,
      width: RIGHT - x,
      pageIndex: 0,
    },
  });

  // Once a real continuation line has set the paragraph's margin, a line
  // indented right of it opens a paragraph even when the line above runs to
  // the margin.
  test("an indented line after full-width continuation lines opens a paragraph", () => {
    expect(
      readPdfLineJoins([
        pdfLine(
          "Krajský súd v Bratislave preskúmal napadnuté rozhodnutie",
          0,
          90,
        ),
        pdfLine(
          "v rozsahu podaného odvolania a dospel k záveru, že odvolanie",
          1,
          LEFT,
        ),
        pdfLine(
          "žalobcu nie je dôvodné, pretože prvostupňový súd vec správne",
          2,
          LEFT,
        ),
        pdfLine(
          "a súčasne poukazuje na to, že žalobca v konaní nepreukázal",
          3,
          90,
        ),
        pdfLine(
          "splnenie podmienok, na ktoré zákon viaže vznik nároku.",
          4,
          LEFT,
        ),
      ]),
    ).toEqual([
      LINE_JOINS.BREAK,
      LINE_JOINS.SPACE,
      LINE_JOINS.SPACE,
      LINE_JOINS.BREAK,
      LINE_JOINS.SPACE,
    ]);
  });

  // A list item's lines hang at its text column, right of the marker; they
  // continue the item.
  test("lines aligned with a list marker's text column continue the item", () => {
    expect(
      readPdfLineJoins([
        pdfLine(
          "a) žalobca je povinný zaplatiť žalovanému trovy konania",
          0,
          LEFT,
        ),
        pdfLine("v sume určenej súdom prvej inštancie v samostatnom", 1, 86),
        pdfLine(
          "uznesení, ktoré vydá po právoplatnosti tohto rozsudku,",
          2,
          86,
        ),
      ]),
    ).toEqual([LINE_JOINS.BREAK, LINE_JOINS.SPACE, LINE_JOINS.SPACE]);
  });

  /** A full-width body line on page 0 at `y`, set in type `height` points tall. */
  const sizedLine = (
    text: string,
    y: number,
    height: number,
  ): PdfPrintedLine => ({
    kind: PDF_LINE_KIND.BODY,
    text,
    layout: { x: LEFT, y, height, width: RIGHT - LEFT, pageIndex: 0 },
  });

  // A page that quotes in smaller, tighter type has as many 11-point steps
  // as 18-point ones. Prose keeps reading at its own leading; only the wider
  // step between prose and quote opens a paragraph.
  test("prose and a quote in smaller type each read at their own leading", () => {
    expect(
      readPdfLineJoins([
        sizedLine(
          "Krajský súd v Bratislave preskúmal napadnuté rozhodnutie",
          700,
          12,
        ),
        sizedLine(
          "v rozsahu podaného odvolania a dospel k záveru, že odvolanie",
          682,
          12,
        ),
        sizedLine(
          "žalobcu nie je dôvodné a poukazuje na ustanovenie, podľa",
          664,
          12,
        ),
        sizedLine(
          "ktorého súd rozhodne o trovách konania v rozsudku, ktorým sa",
          634,
          9,
        ),
        sizedLine(
          "konanie končí, a to podľa pomeru úspechu strán v konaní a",
          623,
          9,
        ),
        sizedLine(
          "podľa zásady, že trovy znáša strana, ktorá nemala úspech",
          612,
          9,
        ),
      ]),
    ).toEqual([
      LINE_JOINS.BREAK,
      LINE_JOINS.SPACE,
      LINE_JOINS.SPACE,
      LINE_JOINS.BREAK,
      LINE_JOINS.SPACE,
      LINE_JOINS.SPACE,
    ]);
  });
});
