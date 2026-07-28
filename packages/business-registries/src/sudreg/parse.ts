import { SudregParseError } from "./errors.js";
import type { SudregAddress, SudregCompany, SudregWarning } from "./types.js";

const NOT_FOUND_TEXT =
  "U sudskom registru nije evidentirano društvo sa zadanim matičnim brojem";
const SECTION_HEADING_PATTERN =
  /<h2\b[^>]*class=["'][^"']*\bsrn-kat-title\b[^"']*["'][^>]*>(?<title>[\s\S]*?)<\/h2>/giu;
const TABLE_CELL_PATTERN = /<td\b[^>]*>(?<value>[\s\S]*?)<\/td>/iu;
const TAG_PATTERN = /<[^>]+>/gu;
const BREAK_PATTERN = /<br\s*\/?\s*>/giu;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const ENTITY_PATTERN = /&(?<entity>#x[\da-f]+|#\d+|[a-z]+);/giu;

const decodeHtmlEntities = (value: string): string => {
  let decoded = "";
  let cursor = 0;
  for (const match of value.matchAll(ENTITY_PATTERN)) {
    const index = match.index;
    const entity = match.groups?.["entity"];
    if (entity === undefined) {
      continue;
    }
    decoded += value.slice(cursor, index);
    if (entity.toLowerCase().startsWith("#x")) {
      decoded += String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    } else if (entity.startsWith("#")) {
      decoded += String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    } else {
      decoded += NAMED_ENTITIES[entity.toLowerCase()] ?? match[0];
    }
    cursor = index + match[0].length;
  }
  return decoded + value.slice(cursor);
};

const htmlToText = (value: string): string =>
  decodeHtmlEntities(
    value.replaceAll(BREAK_PATTERN, "\n").replaceAll(TAG_PATTERN, ""),
  )
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

const extractSection = (
  html: string,
  titles: string | readonly string[],
): string | null => {
  const acceptedTitles = new Set(
    typeof titles === "string" ? [titles] : titles,
  );
  SECTION_HEADING_PATTERN.lastIndex = 0;
  for (const match of html.matchAll(SECTION_HEADING_PATTERN)) {
    const rawTitle = match.groups?.["title"];
    if (!rawTitle || !acceptedTitles.has(htmlToText(rawTitle))) {
      continue;
    }
    const sectionStart = match.index + match[0].length;
    const sectionEnd = html.indexOf("</div>", sectionStart);
    const section = html.slice(
      sectionStart,
      sectionEnd === -1 ? html.length : sectionEnd,
    );
    const cell = TABLE_CELL_PATTERN.exec(section);
    return cell?.groups?.["value"] ? htmlToText(cell.groups["value"]) : null;
  }
  return null;
};

const parseStreet = (
  line: string,
): Pick<
  SudregAddress,
  "street" | "houseNumber" | "orientationNumber" | "orientationLetter"
> => {
  const numberMatch =
    /(?:^|\s)(?<houseNumber>\d+)(?:(?:\s*\/\s*(?<orientationNumber>\d+)(?:\s*(?<orientationLetter>[a-z]))?)|(?:\s*\/\s*(?<slashLetter>[a-z]))|(?:\s*(?<houseLetter>[a-z])))?$/iu.exec(
      line,
    );
  if (!numberMatch?.groups) {
    return {
      street: line || null,
      houseNumber: null,
      orientationNumber: null,
      orientationLetter: null,
    };
  }
  const street = line.slice(0, numberMatch.index).trim();
  return {
    street: street || null,
    houseNumber: numberMatch.groups["houseNumber"] ?? null,
    orientationNumber: numberMatch.groups["orientationNumber"] ?? null,
    orientationLetter:
      numberMatch.groups["orientationLetter"] ??
      numberMatch.groups["slashLetter"] ??
      numberMatch.groups["houseLetter"] ??
      null,
  };
};

export const parseAddress = (
  text: string,
): { address: SudregAddress | null; warnings: SudregWarning[] } => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const municipalityLine = lines.at(0);
  if (!municipalityLine) {
    return { address: null, warnings: [] };
  }

  const municipalityMatch =
    /^(?<part>.*?)\s*\((?:Grad|Općina)\s+(?<municipality>[^)]+)\)$/u.exec(
      municipalityLine,
    );
  const municipality =
    municipalityMatch?.groups?.["municipality"] ?? municipalityLine;
  const municipalityPart = municipalityMatch?.groups?.["part"] || null;
  const unexpectedMunicipality =
    municipalityLine.includes("(") && municipalityMatch === null;
  const street = parseStreet(lines.at(1) ?? "");

  return {
    address: {
      ...street,
      municipalityPart,
      municipality,
      textAddress: lines.join(", "),
    },
    warnings: unexpectedMunicipality
      ? [{ type: "unexpected-address-format" }]
      : [],
  };
};

const buildRegistryUrl = (mbs: string): string =>
  `https://sudreg.pravosudje.hr/ords/r/esudreg/public/28?p28_sbt_mbs=${encodeURIComponent(mbs)}`;

export const parseCompanyPage = (
  html: string,
  requestedMbs: string,
): SudregCompany | null => {
  if (html.includes(NOT_FOUND_TEXT)) {
    return null;
  }

  const mbs = extractSection(html, "MBS") ?? requestedMbs;
  if (mbs !== requestedMbs) {
    throw new SudregParseError(
      `SUDREG returned MBS ${mbs} for requested MBS ${requestedMbs}`,
    );
  }
  const name = extractSection(html, ["Tvrtka", "Naziv"]);
  if (!name) {
    throw new SudregParseError(
      "SUDREG response did not contain a company name",
    );
  }
  const addressText = extractSection(html, "Sjedište/adresa");
  const parsedAddress = addressText
    ? parseAddress(addressText)
    : { address: null, warnings: [] };

  return {
    mbs,
    name,
    address: parsedAddress.address,
    shareCapital: extractSection(html, "Temeljni kapital"),
    legalForm: extractSection(html, "Pravni oblik"),
    warnings: parsedAddress.warnings,
    registryUrl: buildRegistryUrl(mbs),
  };
};
