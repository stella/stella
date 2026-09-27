import { Result } from "better-result";

import { countryFromName } from "./countries";
import { SanctionsListParseError } from "./entry";
import type {
  BirthDate,
  ListVersion,
  ParsedList,
  SanctionsEntry,
  SanctionsName,
  SanctionsSource,
} from "./entry";
import {
  invalidValue,
  missingField,
  parseDayBirthDate,
  parseIsoDate,
} from "./values";

const SOURCE: SanctionsSource = "cz";
const PAGE_URL =
  "https://mzv.gov.cz/jnp/cz/zahranicni_vztahy/sankcni_politika/sankcni_seznam_cr/vnitrostatni_sankcni_seznam.html";

// The published header, trimmed. A changed header fails the parse instead of
// shifting values into the wrong fields.
const COLUMNS = [
  "Příjmení fyzické osoby/název právnické osoby/označení nebo název entity",
  "Jméno fyzické osoby",
  "Stav zápisu",
  "Poznámka ke stavu zápisu",
  "Datum narození fyzické osoby",
  "Státní příslušnost fyzické osoby /sídlo právnické osoby",
  "Datum zápisu či jeho změny",
  "Právní předpis zápisu",
  "Ustanovení předpisu Evropské unie, jehož skutkovou podstatu subjekt jednáním naplnil",
  "Popis postižitelného jednání",
  "Uplatňovaná omezující opatření",
] as const;

// Amended and revoked rows stay in the file as history next to the row in
// force; only "platný" rows are current designations.
const STATUS = {
  platný: "in-force",
  změněn: "superseded",
  zrušen: "revoked",
} as const;

const isStatus = (value: string): value is keyof typeof STATUS =>
  Object.hasOwn(STATUS, value);

const CZECH_DATE = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/u;
const EDITION_DATE = /(\d{4})_(\d{2})_(\d{2})\.csv$/u;
const MFA_FILE_ID = /\/file\/(\d+)\//u;

const malformed = (message: string) =>
  new SanctionsListParseError({
    code: "malformed-input",
    message,
    source: SOURCE,
  });

/** RFC 4180 records: quoted fields may hold commas, quotes ("") and newlines. */
const parseCsv = (
  text: string,
): Result<string[][], SanctionsListParseError> => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    switch (char) {
      case '"':
        if (field !== "") {
          return Result.err(malformed(`stray quote in row ${rows.length + 1}`));
        }
        quoted = true;
        break;
      case ",":
        row.push(field);
        field = "";
        break;
      case "\r":
        break;
      case "\n":
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        break;
      default:
        field += char;
    }
  }
  if (quoted) {
    return Result.err(malformed("the file ends inside a quoted field"));
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return Result.ok(rows);
};

const czechDate = (value: string): Result<string, SanctionsListParseError> => {
  const match = CZECH_DATE.exec(value);
  if (match === null) {
    return Result.err(
      invalidValue(SOURCE, `"${value}" is not a DD.MM.YYYY date`),
    );
  }
  const [, day, month, year] = match;
  if (day === undefined || month === undefined || year === undefined) {
    return Result.err(
      invalidValue(SOURCE, `"${value}" is not a DD.MM.YYYY date`),
    );
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return parseIsoDate(SOURCE, iso).map(() => iso);
};

const variants = (value: string): string[] =>
  value
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "");

const scriptOf = (value: string): string => {
  for (const script of ["Cyrillic", "Georgian", "Arabic"]) {
    if (new RegExp(`\\p{Script=${script}}`, "u").test(value)) {
      return script;
    }
  }
  return "Latin";
};

// The list writes each part of a name in several transcriptions joined by
// "/". Surnames and given names pair within one script, so a Cyrillic surname
// never gets a Latin given name.
const personNames = (
  surnames: string[],
  givenNames: string[],
): SanctionsName[] => {
  const names = new Set<string>();
  for (const surname of surnames) {
    const script = scriptOf(surname);
    const sameScript = givenNames.filter((given) => scriptOf(given) === script);
    for (const given of sameScript.length > 0
      ? sameScript
      : givenNames.slice(0, 1)) {
      names.add(`${given} ${surname}`);
    }
  }
  return [...names].map((name) => ({ name, quality: "strong" }));
};

const entry = (
  cells: readonly string[],
  rowNumber: number,
): Result<SanctionsEntry | null, SanctionsListParseError> =>
  Result.gen(function* () {
    const cell = (column: number) => cells[column]?.trim() ?? "";
    const status = cell(2);
    if (!isStatus(status)) {
      return Result.err(
        invalidValue(SOURCE, `row ${rowNumber} has status "${status}"`),
      );
    }
    if (STATUS[status] !== "in-force") {
      return Result.ok(null);
    }
    const surnames = variants(cell(0));
    const givenNames = variants(cell(1));
    const primary = surnames.at(0);
    if (primary === undefined) {
      return Result.err(missingField(SOURCE, `row ${rowNumber} has no name`));
    }
    const isPerson = givenNames.length > 0;
    const born = cell(4) === "" ? null : yield* czechDate(cell(4));
    const birthDates: BirthDate[] =
      born === null ? [] : [yield* parseDayBirthDate(SOURCE, born, false)];
    const countries = cell(5)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(countryFromName);
    const listedOn = cell(6) === "" ? null : yield* czechDate(cell(6));
    const parsed: SanctionsEntry = {
      source: SOURCE,
      // The list has no entry ids; the primary name and birth date identify a row.
      sourceId: [primary, givenNames.at(0), born]
        .filter((part) => part !== undefined && part !== null)
        .join(" "),
      referenceNumber: null,
      entityType: isPerson ? "person" : "organisation",
      names: isPerson
        ? personNames(surnames, givenNames)
        : surnames.map((name) => ({ name, quality: "strong" as const })),
      birthDates,
      nationalities: isPerson ? countries : [],
      identifiers: [],
      addresses: isPerson
        ? []
        : countries.map((country) => ({
            street: null,
            city: null,
            region: null,
            postalCode: null,
            country,
          })),
      programme: null,
      legalBasis: cell(7) === "" ? null : cell(7),
      listedOn,
      sourceUrl: PAGE_URL,
    };
    return Result.ok(parsed);
  });

/**
 * Reads the edition from the published file name or download URL, e.g.
 * `.../file/6248997/Vnitrostatni_sankcni_seznam_2026_07_23.csv`; the CSV
 * itself carries no edition stamp.
 */
export const readCzListVersion = (
  fileNameOrUrl: string,
): Result<ListVersion, SanctionsListParseError> => {
  const edition = EDITION_DATE.exec(fileNameOrUrl);
  if (edition === null) {
    return Result.err(
      missingField(
        SOURCE,
        `"${fileNameOrUrl}" does not end in a YYYY_MM_DD.csv edition date`,
      ),
    );
  }
  const [, year, month, day] = edition;
  if (year === undefined || month === undefined || day === undefined) {
    return Result.err(
      missingField(
        SOURCE,
        `"${fileNameOrUrl}" does not end in a YYYY_MM_DD.csv edition date`,
      ),
    );
  }
  const publishedAt = `${year}-${month}-${day}`;
  const version: ListVersion = {
    source: SOURCE,
    publishedAt,
    fileId: MFA_FILE_ID.exec(fileNameOrUrl)?.[1] ?? null,
  };
  return parseIsoDate(SOURCE, publishedAt).map(() => version);
};

type ParseCzListInput = {
  csv: string;
  /** The published file name or download URL; it carries the edition date. */
  fileNameOrUrl: string;
};

/** Parses the Czech national sanctions list CSV published under Act 1/2023 Sb. */
export const parseCzList = ({
  csv,
  fileNameOrUrl,
}: ParseCzListInput): Result<ParsedList, SanctionsListParseError> =>
  Result.gen(function* () {
    const version = yield* readCzListVersion(fileNameOrUrl);
    const rows = yield* parseCsv(csv.replace(/^﻿/u, ""));
    const header = rows.at(0)?.map((column) => column.trim());
    if (
      header === undefined ||
      header.length !== COLUMNS.length ||
      header.some((column, index) => column !== COLUMNS[index])
    ) {
      return Result.err(
        new SanctionsListParseError({
          code: "unexpected-structure",
          message: "the CSV header does not match the published column layout",
          source: SOURCE,
        }),
      );
    }
    const entries: SanctionsEntry[] = [];
    for (const [index, cells] of rows.entries()) {
      if (index === 0 || cells.every((value) => value.trim() === "")) {
        continue;
      }
      if (cells.length !== COLUMNS.length) {
        return Result.err(
          malformed(
            `row ${index + 1} has ${cells.length} of ${COLUMNS.length} columns`,
          ),
        );
      }
      const parsed = yield* entry(cells, index + 1);
      if (parsed !== null) {
        entries.push(parsed);
      }
    }
    if (entries.length === 0) {
      return Result.err(
        new SanctionsListParseError({
          code: "empty-list",
          message: "the Czech list has no entries in force",
          source: SOURCE,
        }),
      );
    }
    return Result.ok({ version, entries });
  });
