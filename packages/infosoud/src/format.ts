import { getEventLabel } from "./codes.js";
import type {
  CaseEvent,
  CaseSearchResult,
  CourtMap,
  HearingsSearchResult,
} from "./types.js";

const csvEscape = (value: string): string => {
  if (
    !value.includes(";") &&
    !value.includes('"') &&
    !value.includes("\n") &&
    !value.includes("\r")
  ) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
};

const isSameNumericCaseMark = (
  result: CaseSearchResult,
  event: Pick<CaseEvent, "znackaId">,
): boolean =>
  event.znackaId.cisloSenatu === result.cislo &&
  event.znackaId.druhVeci === result.druh &&
  event.znackaId.bcVec === result.bcVec &&
  event.znackaId.rocnik === result.rocnik;

const inferPrimaryCaseCourtCode = (result: CaseSearchResult): string | null => {
  const matchingCourtCodes = result.udalosti
    .filter((event) => isSameNumericCaseMark(result, event))
    .map((event) => event.znackaId.organizace.trim())
    .filter((code) => code.length > 0);

  return matchingCourtCodes.at(0) ?? null;
};

export const formatCaseSummary = (result: CaseSearchResult): string => {
  const lines = [
    `Sp. zn.: ${result.cislo} ${result.druh} ${result.bcVec}/${result.rocnik}`,
    `Soud: ${result.organizace}${
      result.nadrizenaOrganizace ? ` (${result.nadrizenaOrganizace})` : ""
    }`,
    `Stav: ${result.stav ?? "?"}${
      result.stavDatum ? ` (od ${result.stavDatum})` : ""
    }`,
  ];

  if (result.platneK) {
    lines.push(`Platné k: ${result.platneK.slice(0, 10)}`);
  }

  if (result.udalosti.length > 0) {
    const primaryCaseCourtCode = inferPrimaryCaseCourtCode(result);
    lines.push("", `Události (${result.udalosti.length}):`);

    for (const event of result.udalosti) {
      const label = getEventLabel(event.udalost) ?? event.udalost;
      const cancelled = event.zruseno ? " [ZRUŠENO]" : "";
      const isRelatedCase =
        !isSameNumericCaseMark(result, event) ||
        (primaryCaseCourtCode !== null &&
          event.znackaId.organizace !== primaryCaseCourtCode);
      const related = isRelatedCase
        ? ` -> ${event.znackaId.cisloSenatu} ${event.znackaId.druhVeci} ${event.znackaId.bcVec}/${event.znackaId.rocnik} ${event.znackaId.organizace}`
        : "";
      lines.push(`  ${event.datum}  ${label}${cancelled}${related}`);
    }
  }

  if (result.navazneVeci.length > 0) {
    lines.push("", "Navazné věci:");
    for (const related of result.navazneVeci) {
      lines.push(
        `  ${related.cisloSenatu} ${related.druhVeci} ${related.bcVec}/${related.rocnik} ${related.organizace}`,
      );
    }
  }

  return lines.join("\n");
};

export const formatHearingsSummary = (result: HearingsSearchResult): string => {
  const lines = [`Jednání – ${result.organizace}`];

  if (result.udalosti.length === 0) {
    lines.push("  Žádná jednání nařízena.");
    return lines.join("\n");
  }

  for (const hearing of result.udalosti) {
    const cancelled = hearing.jednaniZruseno ? " [ZRUŠENO]" : "";
    lines.push(
      `  ${hearing.datum} ${hearing.cas}  ${hearing.druhJednani ?? "?"}${cancelled}`,
    );
    lines.push(`    Soudce: ${hearing.resitel ?? "?"}`);
    lines.push(`    Síň: ${hearing.jednaciSin ?? "?"}`);
  }

  return lines.join("\n");
};

export const serializeCourtMapCsv = (courtMap: CourtMap): string => {
  const rows = ["kod;nazev"];
  const sortedEntries = Object.entries(courtMap).toSorted((left, right) =>
    left[1].localeCompare(right[1], "cs-CZ"),
  );

  for (const [code, name] of sortedEntries) {
    rows.push(`${csvEscape(code)};${csvEscape(name)}`);
  }

  return rows.join("\n");
};

export const serializeCaseEventsCsv = (result: CaseSearchResult): string => {
  const rows = ["datum;udalost;zruseno;souvisejici_spzn;soud"];

  for (const event of result.udalosti) {
    const related = `${event.znackaId.cisloSenatu} ${event.znackaId.druhVeci} ${event.znackaId.bcVec}/${event.znackaId.rocnik} ${event.znackaId.organizace}`;
    rows.push(
      [
        csvEscape(event.datum),
        csvEscape(getEventLabel(event.udalost) ?? event.udalost),
        csvEscape(event.zruseno ? "Ano" : ""),
        csvEscape(related.trim()),
        csvEscape(result.organizace),
      ].join(";"),
    );
  }

  return rows.join("\n");
};

export const serializeHearingsCsv = (result: HearingsSearchResult): string => {
  const rows = [
    "datum;cas;druh_jednani;zruseno;jednaci_sin;soudce;vysledek;predmet_jednani;neverejne_jednani;soud",
  ];

  for (const hearing of result.udalosti) {
    rows.push(
      [
        csvEscape(hearing.datum),
        csvEscape(hearing.cas),
        csvEscape(hearing.druhJednani ?? ""),
        csvEscape(hearing.jednaniZruseno ? "Ano" : ""),
        csvEscape(hearing.jednaciSin ?? ""),
        csvEscape(hearing.resitel ?? ""),
        csvEscape(hearing.vysledek ?? ""),
        csvEscape(hearing.predmetJednani ?? ""),
        csvEscape(hearing.neverejneJednani ? "Ano" : ""),
        csvEscape(result.organizace),
      ].join(";"),
    );
  }

  return rows.join("\n");
};
