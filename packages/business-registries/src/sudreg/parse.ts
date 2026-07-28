import { SudregParseError } from "./errors.js";
import type { SudregAddress, SudregCompany, SudregWarning } from "./types.js";

const NOT_FOUND_TEXT =
  "U sudskom registru nije evidentirano društvo sa zadanim matičnim brojem";
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

const withoutHtmlTags = (value: string): string => {
  let text = "";
  let cursor = 0;
  while (cursor < value.length) {
    const tagStart = value.indexOf("<", cursor);
    if (tagStart === -1) {
      return text + value.slice(cursor);
    }
    text += value.slice(cursor, tagStart);
    const tagEnd = value.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      return text + value.slice(tagStart);
    }
    const tag = value
      .slice(tagStart + 1, tagEnd)
      .trim()
      .toLowerCase();
    if (tag === "br" || tag === "br/" || tag.startsWith("br ")) {
      text += "\n";
    }
    cursor = tagEnd + 1;
  }
  return text;
};

const htmlToText = (value: string): string =>
  decodeHtmlEntities(withoutHtmlTags(value))
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

const attributeValue = (openingTag: string, name: string): string | null => {
  const lower = openingTag.toLowerCase();
  const marker = `${name.toLowerCase()}=`;
  const markerStart = lower.indexOf(marker);
  if (markerStart === -1) {
    return null;
  }
  const valueStart = markerStart + marker.length;
  const quote = openingTag[valueStart];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const valueEnd = openingTag.indexOf(quote, valueStart + 1);
  return valueEnd === -1 ? null : openingTag.slice(valueStart + 1, valueEnd);
};

const hasClass = (openingTag: string, className: string): boolean =>
  attributeValue(openingTag, "class")?.split(/\s+/u).includes(className) ??
  false;

const extractSections = (html: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, string>();
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const headingStart = lower.indexOf("<h2", cursor);
    if (headingStart === -1) {
      break;
    }
    const openingEnd = html.indexOf(">", headingStart + 3);
    if (openingEnd === -1) {
      break;
    }
    const closingStart = lower.indexOf("</h2>", openingEnd + 1);
    if (closingStart === -1) {
      break;
    }
    cursor = closingStart + 5;
    if (!hasClass(html.slice(headingStart, openingEnd + 1), "srn-kat-title")) {
      continue;
    }
    const title = htmlToText(html.slice(openingEnd + 1, closingStart));
    const sectionEnd = lower.indexOf("</div>", cursor);
    const boundedEnd = sectionEnd === -1 ? html.length : sectionEnd;
    const cellStart = lower.indexOf("<td", cursor);
    if (cellStart === -1 || cellStart >= boundedEnd) {
      continue;
    }
    const cellOpeningEnd = html.indexOf(">", cellStart + 3);
    if (cellOpeningEnd === -1 || cellOpeningEnd >= boundedEnd) {
      continue;
    }
    const cellEnd = lower.indexOf("</td>", cellOpeningEnd + 1);
    if (cellEnd === -1 || cellEnd > boundedEnd) {
      continue;
    }
    sections.set(title, htmlToText(html.slice(cellOpeningEnd + 1, cellEnd)));
  }
  return sections;
};

const parseStreet = (
  line: string,
): Pick<
  SudregAddress,
  "street" | "houseNumber" | "orientationNumber" | "orientationLetter"
> => {
  const suffixMatch = /^(?<houseNumber>\d+)(?:\/(?<orientation>[\da-z]+))?$/iu;
  const words = line.split(/\s+/u);
  const lastWord = words.at(-1) ?? "";
  const precedingWord = words.at(-2) ?? "";
  const separateLetter = /^[a-z]$/iu.test(lastWord);
  const suffix = (separateLetter ? precedingWord : lastWord).replaceAll(
    /\s/gu,
    "",
  );
  const numberMatch = suffixMatch.exec(suffix);
  if (!numberMatch?.groups) {
    return {
      street: line || null,
      houseNumber: null,
      orientationNumber: null,
      orientationLetter: null,
    };
  }
  const suffixStart = line.lastIndexOf(
    separateLetter ? precedingWord : lastWord,
  );
  const street = line.slice(0, suffixStart).trim();
  const orientation = numberMatch.groups["orientation"] ?? null;
  let orientationLetter: string | null = null;
  if (separateLetter) {
    orientationLetter = lastWord;
  } else if (orientation && /^[a-z]+$/iu.test(orientation)) {
    orientationLetter = orientation;
  }
  return {
    street: street || null,
    houseNumber: numberMatch.groups["houseNumber"] ?? null,
    orientationNumber:
      orientation && /^\d+$/u.test(orientation) ? orientation : null,
    orientationLetter,
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

  const wrapperStart = municipalityLine.lastIndexOf(" (");
  const wrapper =
    wrapperStart === -1 || !municipalityLine.endsWith(")")
      ? null
      : municipalityLine.slice(wrapperStart + 2, -1);
  let municipality = municipalityLine;
  if (wrapper?.startsWith("Grad ") === true) {
    municipality = wrapper.slice(5);
  } else if (wrapper?.startsWith("Općina ") === true) {
    municipality = wrapper.slice(7);
  }
  const municipalityPart =
    municipality === municipalityLine
      ? null
      : municipalityLine.slice(0, wrapperStart).trim() || null;
  const unexpectedMunicipality =
    municipalityLine.includes("(") && municipality === municipalityLine;
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

  const sections = extractSections(html);
  const mbs = sections.get("MBS") ?? requestedMbs;
  if (mbs !== requestedMbs) {
    throw new SudregParseError(
      `SUDREG returned MBS ${mbs} for requested MBS ${requestedMbs}`,
    );
  }
  const name = sections.get("Tvrtka") ?? sections.get("Naziv");
  if (!name) {
    throw new SudregParseError(
      "SUDREG response did not contain a company name",
    );
  }
  const addressText = sections.get("Sjedište/adresa") ?? null;
  const parsedAddress = addressText
    ? parseAddress(addressText)
    : { address: null, warnings: [] };

  return {
    mbs,
    name,
    address: parsedAddress.address,
    shareCapital: sections.get("Temeljni kapital") ?? null,
    legalForm: sections.get("Pravni oblik") ?? null,
    warnings: parsedAddress.warnings,
    registryUrl: buildRegistryUrl(mbs),
  };
};
