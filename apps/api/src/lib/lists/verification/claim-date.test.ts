/**
 * Reading the date a claim asserts from its own words: every way a date is
 * written reads back at the precision it was written, a range or several
 * dates read as the smallest unit covering them, and words without a date
 * (prose, relative dates, identifiers) never produce one.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { PartialDate } from "@/api/lib/lists/fact-details";
import {
  claimAssertedDate,
  readClaimTextDate,
} from "@/api/lib/lists/verification/claim-date";
import type { ClaimTextDate } from "@/api/lib/lists/verification/claim-date";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Month names as written after a day, spelled out here rather than taken
 *  from the platform the reader uses, so missing calendar data fails. */
const IN_DATE_MONTHS = {
  cs: [
    "ledna",
    "února",
    "března",
    "dubna",
    "května",
    "června",
    "července",
    "srpna",
    "září",
    "října",
    "listopadu",
    "prosince",
  ],
  sk: [
    "januára",
    "februára",
    "marca",
    "apríla",
    "mája",
    "júna",
    "júla",
    "augusta",
    "septembra",
    "októbra",
    "novembra",
    "decembra",
  ],
  pl: [
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
  ],
  de: [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ],
  es: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
} as const;

const inDate = (locale: keyof typeof IN_DATE_MONTHS, month: number) =>
  IN_DATE_MONTHS[locale][month - 1] ??
  expect.unreachable("A month outside the calendar");

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const iso = (year: number, month: number, day: number) =>
  `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

const daysIn = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const monthName = (month: number) =>
  MONTHS[month - 1] ?? expect.unreachable("A month outside the calendar");

const ordinal = (day: number) => {
  if (day % 10 === 1 && day !== 11) {
    return `${String(day)}st`;
  }
  if (day % 10 === 2 && day !== 12) {
    return `${String(day)}nd`;
  }
  if (day % 10 === 3 && day !== 13) {
    return `${String(day)}rd`;
  }
  return `${String(day)}th`;
};

const calendarDay = fc
  .record({
    year: fc.integer({ min: 1900, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayFraction: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
  })
  .map(({ year, month, dayFraction }) => ({
    year,
    month,
    day: 1 + Math.floor(dayFraction * daysIn(year, month)),
  }));

type Day = { year: number; month: number; day: number };

/** Every way a day is written that the reader must read as that day. */
const DAY_SPELLINGS: readonly ((day: Day) => string)[] = [
  ({ year, month, day }) =>
    `${String(day)} ${monthName(month)} ${String(year)}`,
  ({ year, month, day }) =>
    `the ${ordinal(day)} of ${monthName(month)}, ${String(year)}`,
  ({ year, month, day }) =>
    `${monthName(month)} ${String(day)}, ${String(year)}`,
  ({ year, month, day }) =>
    `${monthName(month).slice(0, 3)}. ${ordinal(day)} ${String(year)}`,
  ({ year, month, day }) => iso(year, month, day),
  ({ year, month, day }) => `${String(day)}. ${String(month)}. ${String(year)}`,
  ({ year, month, day }) => `${pad(day)}.${pad(month)}.${String(year)}`,
  ({ year, month, day }) =>
    `${String(day)}. ${inDate("cs", month)} ${String(year)}`,
  ({ year, month, day }) =>
    `${String(day)}. ${inDate("sk", month)} ${String(year)}`,
  ({ year, month, day }) =>
    `${String(day)} ${inDate("pl", month)} ${String(year)}`,
  ({ year, month, day }) =>
    `${monthName(month).toUpperCase()} ${String(day)}, ${String(year)}`,
  ({ year, month, day }) =>
    `${String(day)}. ${inDate("de", month)} ${String(year)}`,
  ({ year, month, day }) =>
    `${String(day)} de ${inDate("es", month)} de ${String(year)}`,
];

/** Prose with no digits and no month names: what claims say around dates. */
const NOISE_WORDS = [
  "the",
  "witness",
  "said",
  "that",
  "board",
  "approved",
  "policy",
  "letter",
  "was",
  "sent",
  "to",
  "every",
  "ward",
  "I",
  "met",
  "him",
  "at",
  "office",
  "she",
  "never",
  "received",
  "invoice",
  "paid",
  "may",
  "march",
  "on",
  "in",
  "and",
  "report",
  "(",
  ")",
  ",",
  ";",
  "\u2014",
  "\u00a0",
  "příloha",
  "smlouvu",
  "شاهد",
] as const;

const noise = fc
  .array(fc.constantFrom(...NOISE_WORDS), { maxLength: 12 })
  .map((words) => words.join(" "));

const inProse = (date: string) =>
  fc
    .tuple(noise, noise)
    .map(([before, after]) => `${before} ${date} ${after}`.trim());

/** Spoken without a calendar date: never a date. */
const RELATIVE = [
  "the next day",
  "the day before",
  "a week later",
  "two weeks after the meeting",
  "yesterday",
  "last Monday",
  "on Friday",
  "the following month",
  "earlier that year",
  "shortly afterwards",
  "three days before the hearing",
  "at the end of the week",
] as const;

const dated = (date: PartialDate): ClaimTextDate => ({
  type: "dated",
  ...date,
});

describe("claim date reader", () => {
  test("reads a written day at day precision in surrounding prose", () => {
    assertProperty(
      "reads a written day at day precision in surrounding prose",
      fc.property(
        calendarDay.chain((day) =>
          fc
            .constantFrom(...DAY_SPELLINGS)
            .chain((spell) => inProse(spell(day)))
            .map((text) => ({ day, text })),
        ),
        ({ day, text }) => {
          expect(readClaimTextDate(text)).toEqual(
            dated({
              date: iso(day.year, day.month, day.day),
              precision: "day",
            }),
          );
        },
      ),
    );
  });

  test("reads a written month at month precision", () => {
    assertProperty(
      "reads a written month at month precision",
      fc.property(
        calendarDay.chain(({ year, month }) =>
          fc
            .constantFrom(
              `${monthName(month)} ${String(year)}`,
              `in ${monthName(month)}, ${String(year)}`,
              `${monthName(month).slice(0, 3)} ${String(year)}`,
            )
            .chain(inProse)
            .map((text) => ({ year, month, text })),
        ),
        ({ year, month, text }) => {
          expect(readClaimTextDate(text)).toEqual(
            dated({ date: iso(year, month, 1), precision: "month" }),
          );
        },
      ),
    );
  });

  test("reads a written year at year precision", () => {
    assertProperty(
      "reads a written year at year precision",
      fc.property(
        fc.integer({ min: 1900, max: 2099 }).chain((year) =>
          fc
            .constantFrom(
              `in ${String(year)}`,
              `during ${String(year)}`,
              `mid-${String(year)}`,
            )
            .chain(inProse)
            .map((text) => ({ year, text })),
        ),
        ({ year, text }) => {
          expect(readClaimTextDate(text)).toEqual(
            dated({ date: iso(year, 1, 1), precision: "year" }),
          );
        },
      ),
    );
  });

  test("a range inside one month reads as that month", () => {
    assertProperty(
      "a range inside one month reads as that month",
      fc.property(
        calendarDay,
        calendarDay,
        fc.constantFrom("-", "\u2013", " to ", " and "),
        fc.boolean(),
        (a, b, connector, monthFirst) => {
          const from = Math.min(a.day, b.day);
          const to = Math.max(a.day, b.day);
          const { year, month } = a;
          const last = Math.min(to, daysIn(year, month));
          const text = monthFirst
            ? `on ${monthName(month)} ${String(from)}${connector}${String(last)}, ${String(year)}`
            : `between ${String(from)}${connector}${String(last)} ${monthName(month)} ${String(year)}`;
          expect(readClaimTextDate(text)).toEqual(
            dated({ date: iso(year, month, 1), precision: "month" }),
          );
        },
      ),
    );
  });

  test("several dates read as the smallest unit covering them all", () => {
    assertProperty(
      "several dates read as the smallest unit covering them all",
      fc.property(
        fc.array(calendarDay, { minLength: 2, maxLength: 4 }),
        noise,
        (days, filler) => {
          const text = days
            .map(
              (day) =>
                `on ${String(day.day)} ${monthName(day.month)} ${String(day.year)}`,
            )
            .join(` ${filler} and `);
          const [first] = days;
          if (first === undefined) {
            return;
          }
          const read = readClaimTextDate(text);
          if (days.some((day) => day.year !== first.year)) {
            expect(read).toEqual({ type: "spread" });
            return;
          }
          if (days.some((day) => day.month !== first.month)) {
            expect(read).toEqual(
              dated({ date: iso(first.year, 1, 1), precision: "year" }),
            );
            return;
          }
          expect(read).toEqual(
            days.some((day) => day.day !== first.day)
              ? dated({
                  date: iso(first.year, first.month, 1),
                  precision: "month",
                })
              : dated({
                  date: iso(first.year, first.month, first.day),
                  precision: "day",
                }),
          );
        },
      ),
    );
  });

  test("relative dates and prose without digits never read as a date", () => {
    assertProperty(
      "relative dates and prose without digits never read as a date",
      fc.property(
        fc.array(fc.oneof(noise, fc.constantFrom(...RELATIVE)), {
          maxLength: 6,
        }),
        fc.string({ maxLength: 40 }).map((text) => text.replaceAll(/\d/gu, "")),
        (parts, arbitrary) => {
          const text = [...parts, arbitrary].join(" ");
          expect(/\d/u.test(text)).toBe(false);
          expect(readClaimTextDate(text)).toEqual({ type: "silent" });
        },
      ),
    );
  });

  test("a day and month without a year take the year written beside them", () => {
    assertProperty(
      "a day and month without a year take the year written beside them",
      fc.property(calendarDay, noise, (day, filler) => {
        const text = `On ${String(day.day)} ${monthName(day.month)} ${filler}, in ${String(day.year)}`;
        expect(readClaimTextDate(text)).toEqual(
          dated({ date: iso(day.year, 1, 1), precision: "year" }),
        );
        expect(
          readClaimTextDate(
            `On ${String(day.day)} ${monthName(day.month)} ${filler}`,
          ),
        ).toEqual({ type: "silent" });
      }),
    );
  });

  test("an identifier or an amount is never read as a year", () => {
    assertProperty(
      "an identifier or an amount is never read as a year",
      fc.property(
        fc.integer({ min: 1900, max: 2099 }),
        fc.constantFrom(
          "Invoice No. ",
          "paragraph ",
          "clause ",
          "page ",
          "£",
          "$ ",
          "§ ",
          "ref ",
        ),
        noise,
        (year, before, filler) => {
          expect(
            readClaimTextDate(`${filler} ${before}${String(year)} ${filler}`),
          ).toEqual({
            type: "silent",
          });
        },
      ),
    );
  });

  test("a numeric date whose order depends on where it was written is left to the grader", () => {
    assertProperty(
      "a numeric date whose order depends on where it was written is left to the grader",
      fc.property(calendarDay, fc.constantFrom("/", "-"), (day, separator) => {
        const text = `I signed it on ${pad(day.day)}${separator}${pad(day.month)}${separator}${String(day.year)}.`;
        expect(readClaimTextDate(text)).toEqual({ type: "silent" });
      }),
    );
  });

  test("days that do not exist are not dates", () => {
    expect(readClaimTextDate("On 31 June 2021 I signed.")).toEqual({
      type: "silent",
    });
    expect(readClaimTextDate("On 29 February 2021 I signed.")).toEqual({
      type: "silent",
    });
    expect(readClaimTextDate("On 29 February 2020 I signed.")).toEqual(
      dated({ date: "2020-02-29", precision: "day" }),
    );
  });

  test("English month names are capitalised, so a verb is never a month", () => {
    expect(readClaimTextDate("I may 2 times have asked in 2021.")).toEqual(
      dated({ date: "2021-01-01", precision: "year" }),
    );
    expect(readClaimTextDate("I met him on 10 May 2021.")).toEqual(
      dated({ date: "2021-05-10", precision: "day" }),
    );
  });
});

describe("claim asserted date", () => {
  const graderDate = { date: "2021-08-17", precision: "day" } as const;

  test("the words win over the grader, which is read only when they name no date", () => {
    expect(
      claimAssertedDate("On 10 August 2021 I called.", graderDate),
    ).toEqual({
      type: "dated",
      source: "text",
      date: "2021-08-10",
      precision: "day",
    });
    expect(claimAssertedDate("On 10 August I called.", graderDate)).toEqual({
      type: "dated",
      source: "grader",
      ...graderDate,
    });
    expect(claimAssertedDate("On 10 August I called.", null)).toEqual({
      type: "none",
    });
  });

  test("dates no year covers stay undated whatever the grader says", () => {
    expect(
      claimAssertedDate("From 2019 to 2021 I worked there.", graderDate),
    ).toEqual({
      type: "none",
    });
  });
});
