import { describe, expect, test } from "bun:test";

import { normalizeUnicode } from "@stll/text-normalize";

import {
  separateOpinionAuthorLine,
  separateOpinionHeadingNamesAuthor,
  separateOpinionHeadingTail,
} from "./separate-opinion-heading.js";

const HEADING_CASES = [
  ["Odlišné stanovisko", ""],
  ["Odlišné stanovisko:", ":"],
  ["Odlišné stanovisko soudce Jana Nováka", " soudce Jana Nováka"],
  ["Odlišná stanoviska soudců", " soudců"],
  ["Stanovisko menšiny", ""],
  ["Paralelní stanovisko soudkyně", " soudkyně"],
  ["Paralelní stanoviska soudkyň", " soudkyň"],
  ["Konkurující stanovisko soudce", " soudce"],
  ["Konkurující stanoviska soudců", " soudců"],
  ["Souhlasné stanovisko soudce", " soudce"],
  ["Souhlasná stanoviska soudkyň", " soudkyň"],
  ["Odlišné stanovisko sudcu Jána Nováka", " sudcu Jána Nováka"],
  ["Odlišné stanoviská sudcov", " sudcov"],
  ["Paralelné stanovisko sudkyne", " sudkyne"],
  ["Paralelné stanoviská sudkýň", " sudkýň"],
  ["Konkurujúce stanovisko sudcu", " sudcu"],
  ["Konkurujúce stanoviská sudcov", " sudcov"],
  ["Súhlasné stanovisko sudkyne", " sudkyne"],
  ["Súhlasné stanoviská sudkýň", " sudkýň"],
  ["Odlišné stanovisko k nálezu pléna", " k nálezu pléna"],
  ["Paralelné stanovisko ku rozhodnutiu", " ku rozhodnutiu"],
  ["Konkurujúce stanovisko vo veci", " vo veci"],
  ["Súhlasné stanovisko podľa § 32", " podľa § 32"],
  ["Odlišné stanovisko JUDr. Jana Nováka", " JUDr. Jana Nováka"],
  ["Odlišné stanovisko JUDr Jana Nováka", " JUDr Jana Nováka"],
  ["ODLISNE stanovisko sudcu Jána Nováka", " sudcu Jána Nováka"],
  [
    "Konkurujúce stanovisko sudkyne Ľudmily Novákovej",
    " sudkyne Ľudmily Novákovej",
  ],
  ["STANOVISKO", ""],
] as const;

describe("CS/SK separate-opinion heading vocabulary", () => {
  test.each(HEADING_CASES)(
    "reads %j without changing its tail",
    (heading, tail) => {
      expect(separateOpinionHeadingTail(heading, 300)).toBe(tail);
    },
  );

  test.each([
    "Odlišné stanovisko odůvodňuji takto:",
    "Odlišné stanovisko k této otázce uplatnili dva soudci",
    "Odlišné stanovisko uplatnili dva soudci",
    "Odlišné stanovisko odôvodňujem takto:",
    "Paralelné stanovisko k tejto otázke pripojili dvaja sudcovia",
    "Konkurujúce stanovisko som pripojil k nálezu",
    "Souhlasné stanovisko vyjadřuji takto:",
    "Súhlasné stanovisko vyjadrujem takto:",
    "Odlišné stanovisko soudcovství změnilo",
    "Odlišné stanovisko sudcovstvo zmenilo",
    "Stanovisko",
    "stanovisko",
  ])("leaves prose or an unsupported bare title as text: %s", (heading) => {
    expect(separateOpinionHeadingTail(heading, 300)).toBeUndefined();
  });

  test("preserves decomposed diacritics and spacing in the original tail", () => {
    const title = normalizeUnicode("Konkurujúce\tstanovisko", "NFD");
    const tail = normalizeUnicode("  sudkyne Ľudmily Novákovej", "NFD");
    expect(tail).not.toBe(normalizeUnicode(tail, "NFC"));
    expect(separateOpinionHeadingTail(`${title}${tail}`, 300)).toBe(tail);
  });

  test("enforces the caller's heading length boundary", () => {
    const heading =
      "Odlišné stanovisko soudce Petra Nováka dle § 55a soudního řádu správního k rozhodnutí rozšířeného senátu ze dne 30. 6. 2021 ve věci sp. zn. 9 As 264/2020";
    expect(heading.length).toBeGreaterThan(120);
    expect(separateOpinionHeadingTail(heading, 120)).toBeUndefined();
    expect(separateOpinionHeadingTail(heading, heading.length)).toBe(
      heading.slice("Odlišné stanovisko".length),
    );
  });
});

test.each([
  " soudce Jana Nováka",
  " soudkyně",
  " soudců",
  " soudkyň",
  " sudcu Jána Nováka",
  " sudkyne",
  " sudcov",
  " sudkýň",
  " místopředsedkyně",
  " podpredsedníčky",
  " JUDr. Jana Nováka",
  normalizeUnicode(" sudkýň Ľudmily Novákovej", "NFD"),
])("the heading's own author vocabulary also identifies names: %s", (tail) => {
  expect(separateOpinionHeadingTail(`Odlišné stanovisko${tail}`, 300)).toBe(
    tail,
  );
  expect(separateOpinionHeadingNamesAuthor(tail)).toBe(true);
});

test.each([
  "",
  ":",
  " k nálezu pléna",
  " vo veci",
  " podle § 32",
  " soudcovství",
  " sudcovstvo",
])(
  "a tail without an author noun or title does not name an author: %s",
  (tail) => {
    expect(separateOpinionHeadingNamesAuthor(tail)).toBe(false);
  },
);

test.each([
  "k §237",
  "k čl.89",
  "k sp.zn. 1/2026",
  "k č.j. 1/2026",
  "podle §32",
  "podľa §32",
  "ku sp.zn. 1/2026",
])("legal reference targets do not require invented spacing: %s", (target) => {
  const tail = ` ${target}`;
  expect(separateOpinionHeadingTail(`Odlišné stanovisko${tail}`, 300)).toBe(
    tail,
  );
});

test.each([
  "soudce Jana Nováka",
  "soudkyně Evy Novákové",
  "soudců",
  "soudkyň",
  "sudcu Jána Nováka",
  "sudkyne Evy Novákovej",
  "sudcov",
  "sudkýň",
  "JUDr. Jana Nováka",
])("author continuation lines use the heading's own vocabulary: %s", (line) => {
  expect(separateOpinionAuthorLine(line)).toBe(true);
  expect(separateOpinionHeadingNamesAuthor(` ${line}`)).toBe(true);
});

test.each([
  "S většinovým závěrem nesouhlasím.",
  "Nesúhlasím so záverom väčšiny.",
  "k nálezu",
  "soudcovství",
  "sudcovstvo",
  "Text zmiňuje soudce Jana Nováka.",
])("an opinion paragraph is not an author continuation: %s", (line) => {
  expect(separateOpinionAuthorLine(line)).toBe(false);
});
