import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { DECISION_DOCKET_GRAMMARS } from "./decision-docket-grammar";
import {
  ecliSheetOf,
  isWholeEntryIdentifier,
  namedDecisionsOf,
  parseDecisionQuery,
  resolveDecisionIdentity,
  searchTextOfDecisionQuery,
} from "./decision-query-intent";

const canonicalDockets = [
  "22 Cdo 2653/2012",
  "29 NSČR 55/2013",
  "1 As 12/2020",
  "IV. ÚS 23/05",
  "II CSK 123/19",
  "C-131/12",
  "T-449/14",
  "5Ob200/20x",
  "Ra 2020/01/0001",
  "E 123/2019-12",
] as const;

const operators = fc.constantFrom(
  "AND",
  "OR",
  "NOT",
  ":",
  "*",
  "~",
  "(",
  ")",
  "+",
  "-",
  "\\",
  '"',
  "'",
  "§",
  "—",
  "„",
  "”",
);

const adversarialText = fc
  .tuple(
    fc.array(operators, { minLength: 1, maxLength: 5 }),
    fc.stringMatching(/^[a-záčďéěíňóřšťúůýž]{2,10}$/u),
    fc.array(operators, { minLength: 1, maxLength: 5 }),
  )
  .map(([before, word, after]) => `${before.join("")}${word}${after.join("")}`);

describe("case-law query parser properties", () => {
  test(
    "canonical docket values parse to a stable canonical identifier",
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constantFrom(...canonicalDockets),
            fc
              .tuple(
                fc.integer({ min: 1, max: 99 }),
                fc.integer({ min: 1, max: 999_999 }),
                fc.integer({ min: 1900, max: 2099 }),
              )
              .map(
                ([senate, ordinal, year]) => `${senate} Cdo ${ordinal}/${year}`,
              ),
          ),
          (docket) => {
            const first = parseDecisionQuery(docket);
            expect(first).toMatchObject({ type: "identifier", kind: "docket" });
            if (first.type !== "identifier" || first.kind !== "docket") {
              return;
            }

            expect(parseDecisionQuery(first.value)).toEqual(first);
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "operator shaped unrecognized entries remain intact text",
    () => {
      fc.assert(
        fc.property(adversarialText, (text) => {
          expect(parseDecisionQuery(text)).toEqual({ type: "text", text });
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );
});

const scopedShapes = [
  { jurisdiction: "CZE", render: (n: number, y: number) => `7 C ${n}/${y}` },
  { jurisdiction: "CZE", render: (n: number, y: number) => `12 Co ${n}/${y}` },
  { jurisdiction: "CZE", render: (n: number, y: number) => `3 Cmo ${n}/${y}` },
  { jurisdiction: "CZE", render: (n: number, y: number) => `22 Cdo ${n}/${y}` },
  {
    jurisdiction: "CZE",
    render: (n: number, y: number) => `29 NSČR ${n}/${y}`,
  },
  { jurisdiction: "CZE", render: (n: number, y: number) => `1 As ${n}/${y}` },
  { jurisdiction: "CZE", render: (n: number, y: number) => `Nad ${n}/${y}` },
  { jurisdiction: "CZE", render: (n: number, y: number) => `Konf ${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `7C/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `12Co/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `3Cob/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `1Cdo/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `4Sžf/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `2Sžk/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `1Svk/${n}/${y}` },
  { jurisdiction: "SVK", render: (n: number, y: number) => `5Tdo/${n}/${y}` },
] as const;

test(
  "scoped court references retain their jurisdiction and embedded search words",
  () => {
    assertProperty(
      "scoped court references retain their jurisdiction and embedded search words",
      fc.property(
        fc.integer({ min: 1, max: 99_999 }),
        fc.integer({ min: 1993, max: 2030 }),
        (number, year) => {
          for (const { jurisdiction, render } of scopedShapes) {
            const options = { grammar: DECISION_DOCKET_GRAMMARS[jurisdiction] };
            const docket = render(number, year);
            const standalone = parseDecisionQuery(docket, options);
            expect(standalone).toMatchObject({
              type: "identifier",
              kind: "docket",
              jurisdiction,
            });
            expect(isWholeEntryIdentifier(standalone)).toBe(true);
            if (
              standalone.type !== "identifier" ||
              standalone.kind !== "docket"
            ) {
              return;
            }
            expect(parseDecisionQuery(standalone.value, options)).toEqual(
              standalone,
            );
            for (const entry of [
              `rozsudek podle ${docket} o náhradě škody`,
              `uznesenie podľa ${docket} o náhrade škody`,
              `nález ${docket.normalize("NFD")}`,
            ]) {
              const embedded = parseDecisionQuery(entry, options);
              expect(embedded).toEqual({ ...standalone, embeddedIn: entry });
              expect(isWholeEntryIdentifier(embedded)).toBe(false);
              expect(searchTextOfDecisionQuery(embedded)).toBe(entry);
            }
          }
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "constitutional references preserve senate and year width in each scope",
  () => {
    assertProperty(
      "constitutional references preserve senate and year width in each scope",
      fc.property(fc.integer({ min: 1, max: 9999 }), (number) => {
        for (const jurisdiction of ["CZE", "SVK"] as const) {
          const options = { grammar: DECISION_DOCKET_GRAMMARS[jurisdiction] };
          for (const senate of ["I", "II", "III", "IV", "Pl"]) {
            for (const year of ["04", "1998", "2024"]) {
              const entry = `${senate}. ÚS ${number}/${year}`;
              const intent = parseDecisionQuery(entry, options);
              expect(intent).toMatchObject({
                type: "identifier",
                kind: "docket",
                jurisdiction,
                selector: { kind: "none" },
              });
              if (intent.type !== "identifier" || intent.kind !== "docket") {
                return;
              }
              expect(intent.family).toBe(
                jurisdiction === "SVK"
                  ? `${senate.toUpperCase()}. ÚS ${number}/${year}`
                  : entry,
              );
              expect(parseDecisionQuery(intent.value, options)).toEqual(intent);
              const siblingYear =
                year.length === 2 ? `20${year}` : year.slice(-2);
              const hit = {
                caseNumber: `${senate}. ÚS ${number}/${siblingYear}`,
                ecli: null,
              };
              expect(namedDecisionsOf(intent, [hit])).toEqual([]);
            }
          }
        }
      }),
      { numRuns: 20 },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "embedded ECLI token limits include the boundary and preserve longer prose",
  () => {
    assertProperty(
      "embedded ECLI token limits include the boundary and preserve longer prose",
      fc.property(fc.integer({ min: 1, max: 9999 }), (ordinal) => {
        const value = `ECLI:SK:NSSR:2024:${ordinal}`;
        for (const tokens of [2, 31, 32, 33]) {
          const text = `${"rozsudok ".repeat(tokens - 1)}${value}`;
          expect(parseDecisionQuery(text)).toEqual(
            tokens <= 32
              ? { type: "identifier", kind: "ecli", value, embeddedIn: text }
              : { type: "text", text },
          );
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "ECLI component bounds distinguish complete references from near misses",
  () => {
    assertProperty(
      "ECLI component bounds distinguish complete references from near misses",
      fc.property(fc.constantFrom("CZ", "SK"), (country) => {
        for (const courtWidth of [1, 12, 13]) {
          for (const ordinalWidth of [1, 64, 65]) {
            const value = `ECLI:${country}:${"N".repeat(courtWidth)}:2024:${"1".repeat(ordinalWidth)}`;
            expect(parseDecisionQuery(value)).toEqual(
              courtWidth <= 12 && ordinalWidth <= 64
                ? { type: "identifier", kind: "ecli", value }
                : { type: "text", text: value },
            );
          }
        }
        for (const year of ["024", "20245", "20a4"]) {
          const text = `ECLI:${country}:NS:${year}:1`;
          expect(parseDecisionQuery(text)).toEqual({ type: "text", text });
        }
      }),
      { numRuns: 10 },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "NSS sheet numbers ignore numeric padding and require the same file",
  () => {
    assertProperty(
      "NSS sheet numbers ignore numeric padding and require the same file",
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 9999 }),
        (senate, ordinal, sheet) => {
          const family = `${senate}afs${ordinal}/2024`;
          const ecli = `ecli:cz:nss:2024:0${senate}.AFS.00${ordinal}.02024.00${sheet}`;
          expect(ecliSheetOf(ecli, family)).toBe(String(sheet));
          expect(
            ecliSheetOf(ecli, `${senate}afs${ordinal + 1}/2024`),
          ).toBeNull();
          expect(ecliSheetOf(ecli.replace(/\.00\d+$/u, ""), family)).toBeNull();
          expect(ecliSheetOf(`${ecli}.x`, family)).toBeNull();
          expect(ecliSheetOf(ecli.replace(":nss:", ":ns:"), family)).toBeNull();
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "selectors from another file never select a member of the requested file",
  () => {
    assertProperty(
      "selectors from another file never select a member of the requested file",
      fc.property(fc.integer({ min: 1, max: 9999 }), (sheet) => {
        for (const jurisdiction of ["CZE", "SVK"] as const) {
          const options = { grammar: DECISION_DOCKET_GRAMMARS[jurisdiction] };
          const family =
            jurisdiction === "CZE" ? "1 As 12/2024" : "4Sžf/12/2024";
          const other =
            jurisdiction === "CZE" ? "1 As 13/2024" : "4Sžf/13/2024";
          const intent = parseDecisionQuery(`${family}-${sheet}`, options);
          expect(intent).toMatchObject({
            type: "identifier",
            kind: "docket",
            selector: { kind: "sheet", value: String(sheet) },
          });
          if (intent.type !== "identifier") {
            return;
          }
          const hit = {
            caseNumber: family,
            ecli: null,
            publishedCaseNumber: `${other}-${sheet}`,
            identifiers: [{ type: "case-number", value: `${other}-${sheet}` }],
          };
          expect(resolveDecisionIdentity(intent, [hit])).toEqual({
            status: "ambiguous",
            candidates: [hit],
            reason: "selector_unmatched",
          });
          expect(namedDecisionsOf(intent, [hit])).toEqual([hit]);
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "different selectors in repeated references leave the complete entry as text",
  () => {
    assertProperty(
      "different selectors in repeated references leave the complete entry as text",
      fc.property(fc.integer({ min: 1, max: 9998 }), (sheet) => {
        for (const jurisdiction of ["CZE", "SVK"] as const) {
          const options = { grammar: DECISION_DOCKET_GRAMMARS[jurisdiction] };
          const family =
            jurisdiction === "CZE" ? "1 As 12/2024" : "4Sžf/12/2024";
          const text = `rozsudek ${family}-${sheet} a ${family}-${sheet + 1}`;
          expect(parseDecisionQuery(text, options)).toEqual({
            type: "text",
            text,
          });
          const repeated = `rozsudek ${family}-${sheet} a ${family}-${sheet}`;
          const intent = parseDecisionQuery(`${family}-${sheet}`, options);
          expect(intent).toMatchObject({ type: "identifier", kind: "docket" });
          if (intent.type !== "identifier" || intent.kind !== "docket") {
            return;
          }
          expect(parseDecisionQuery(repeated, options)).toEqual({
            ...intent,
            embeddedIn: repeated,
          });
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
);

/** Every typed source a sibling's sheet can be known from, or none. */
const SHEET_SOURCES = [
  "ecli",
  "parallel-identifier",
  "recorded-sheet",
  "published-reference",
  "stored-docket",
  "other-file-recorded-sheet",
  "unknown",
] as const;

type SheetSource = (typeof SHEET_SOURCES)[number];

/**
 * Whether the sheet a source states is a sheet of `SHEET_FILE`. One recorded
 * off another file's docket is not, even on a decision `SHEET_FILE` reaches
 * through a parallel file number.
 */
const STATES_A_SHEET_OF_THE_FILE = {
  ecli: true,
  "parallel-identifier": true,
  "recorded-sheet": true,
  "published-reference": true,
  "stored-docket": true,
  "other-file-recorded-sheet": false,
  unknown: false,
} as const satisfies Record<SheetSource, boolean>;

const SHEET_FILE = "3 Afs 41/2008";
const OTHER_FILE = "5 As 12/2009";

/** A sibling of `SHEET_FILE` whose sheet only `source` states. */
const siblingWithSheetIn = (id: string, source: SheetSource, sheet: number) => {
  const full = `${SHEET_FILE} - ${String(sheet)}`;
  const bare = { id, caseNumber: SHEET_FILE, ecli: null };
  switch (source) {
    case "ecli":
      return {
        ...bare,
        ecli: `ECLI:CZ:NSS:2010:3.AFS.41.2008.${String(sheet)}`,
      };
    case "parallel-identifier":
      return { ...bare, identifiers: [{ type: "case-number", value: full }] };
    case "recorded-sheet":
      return { ...bare, sheetNumber: String(sheet) };
    case "published-reference":
      return { ...bare, publishedCaseNumber: full };
    case "stored-docket":
      return { ...bare, caseNumber: full };
    case "other-file-recorded-sheet":
      // Stored and published under another file, its sheet split off there,
      // and reached here only through the parallel file number.
      return {
        ...bare,
        caseNumber: OTHER_FILE,
        publishedCaseNumber: `${OTHER_FILE}-${String(sheet)}`,
        sheetNumber: String(sheet),
        identifiers: [{ type: "case-number", value: SHEET_FILE }],
      };
    case "unknown":
      return bare;
    default: {
      source satisfies never;
      return panic(`Unhandled sheet source: ${String(source)}`);
    }
  }
};

test(
  "a sheet selects the same siblings whichever source states each sibling's sheet",
  () => {
    assertProperty(
      "a sheet selects the same siblings whichever source states each sibling's sheet",
      fc.property(
        fc.array(
          fc.record({
            source: fc.constantFrom(...SHEET_SOURCES),
            sheet: fc.integer({ min: 1, max: 5 }),
            // An identity read reaches a row stored under another sheet
            // only through some other spelling; the answer may not depend
            // on whether it did.
            reached: fc.boolean(),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 1, max: 6 }),
        (siblings, requested) => {
          const read = parseDecisionQuery(`${SHEET_FILE}-${requested}`, {
            grammar: DECISION_DOCKET_GRAMMARS.CZE,
          });
          const intent =
            read.type === "identifier"
              ? read
              : panic("A sheet reference must read as an identifier");
          const modelled = siblings.map(
            ({ reached, sheet, source }, index) => ({
              id: `sibling-${String(index)}`,
              sheet: STATES_A_SHEET_OF_THE_FILE[source] ? sheet : null,
              present:
                reached || source !== "stored-docket" || sheet === requested,
              hit: siblingWithSheetIn(
                `sibling-${String(index)}`,
                source,
                sheet,
              ),
            }),
          );
          const hits = modelled
            .filter(({ present }) => present)
            .map(({ hit }) => hit);
          // The abstract answer, from sheet values alone.
          const holders = modelled.filter(({ sheet }) => sheet === requested);
          const unknown = modelled.filter(
            ({ present, sheet }) => present && sheet === null,
          );
          const resolution = resolveDecisionIdentity(intent, hits);
          const [onlyHolder] = holders;
          if (holders.length === 1 && onlyHolder !== undefined) {
            expect(resolution).toEqual({
              status: "unique",
              decision: onlyHolder.hit,
              basis: "selector",
            });
          } else if (holders.length > 1) {
            expect(resolution).toEqual({
              status: "ambiguous",
              candidates: holders.map(({ hit }) => hit),
              reason: "several",
            });
          } else if (unknown.length > 0) {
            expect(resolution).toEqual({
              status: "ambiguous",
              candidates: unknown.map(({ hit }) => hit),
              reason: "selector_unmatched",
            });
          } else {
            expect(resolution).toEqual({ status: "none" });
          }
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);
