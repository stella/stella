/**
 * Polish competition and consumer protection authority (Prezes UOKiK)
 * document reader.
 *
 * decyzje.uokik.gov.pl files each decision as a PDF attachment and nothing
 * richer: the register's own page for a decision is a table of its metadata
 * with a link to the file. The text layer is read the way the Supreme Court's
 * PDFs are (indent and blank lines for paragraphs, the font for bold), into
 * the markup the Polish decision parser reads, so there is one Polish parser
 * and this is not a second one.
 */

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { parsePlainDate } from "@stll/time";

import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { PL_NCOURT_COURT_NAMES } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt-courts";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  assemblePlSnParagraphs,
  extractPlSnLines,
  PL_PDF_PARAGRAPH_START,
  plSnParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnLine } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_UOKIK_SOURCE_SYSTEM = "decyzje.uokik.gov.pl";

export type ParsePlUokikDocumentInput = {
  /** Every decision file the record attaches, in the order it lists them. */
  pdfs: readonly Uint8Array[];
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string;
  sourceUrl: string;
  documentUrl: string | undefined;
  documentId: string;
  keywords: string[];
};

export type ParsePlUokikDocumentOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

/**
 * The lines of every file, one after the other. A blank line between two
 * files ends the last paragraph of the first, so no paragraph spans them.
 */
export const plUokikDocumentLines = async (
  pdfs: readonly Uint8Array[],
): Promise<PlSnLine[]> => {
  const lines: PlSnLine[] = [];
  for (const pdf of pdfs) {
    if (lines.length > 0) {
      lines.push({ type: "blank" });
    }
    // The office numbers its paragraphs with a hanging indent.
    lines.push(
      ...(await extractPlSnLines(
        pdf,
        PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
      )),
    );
  }
  return lines;
};

/**
 * The decision's document, or null where its files hold no text layer: a
 * scan states nothing to read, and a document of no paragraphs is not one.
 */
export const parsePlUokikDocument = async (
  input: ParsePlUokikDocumentInput,
): Promise<ParsePlUokikDocumentOutput | null> => {
  const paragraphs = assemblePlSnParagraphs(
    await plUokikDocumentLines(input.pdfs),
  );
  if (paragraphs.length === 0) {
    return null;
  }
  return parsePlDecisionContent({
    caseNumber: input.caseNumber,
    // Poland issues no ECLI, and an authority's decision carries none.
    ecli: undefined,
    court: input.court,
    decisionDate: input.decisionDate,
    decisionType: input.decisionType,
    sourceUrl: input.sourceUrl,
    documentUrl: input.documentUrl ?? "",
    content: plSnParagraphsToHtml(paragraphs),
    keywords: input.keywords,
    statutes: [],
    documentId: input.documentId,
    sourceSystem: PL_UOKIK_SOURCE_SYSTEM,
  });
};

// ── Court rulings the register attaches ──────────────────

/**
 * Why a ruling's header could not be read. A ruling whose court, docket, date
 * or kind its own text does not state in the places a Polish judgment prints
 * them is kept, never filed under a guess.
 */
export const PL_UOKIK_RULING_UNREAD = {
  /** The file holds no text layer: a scan. */
  NO_TEXT: "no-text",
  KIND_NOT_READ: "kind-not-read",
  DOCKET_NOT_READ: "docket-not-read",
  DATE_NOT_READ: "date-not-read",
  COURT_NOT_READ: "court-not-read",
} as const;

export type PlUokikRulingUnread =
  (typeof PL_UOKIK_RULING_UNREAD)[keyof typeof PL_UOKIK_RULING_UNREAD];

export type PlUokikRulingHeader = {
  /** `wyrok`, `postanowienie`, `uchwała` or `zarządzenie`. */
  decisionType: string;
  /** The docket as the header prints it, spacing collapsed. */
  caseNumber: string;
  decisionDate: string;
  /** The court's name as the common courts' index and the Supreme Court use it. */
  court: string;
  /** What the header prints after the court's name, before `w składzie`. */
  divisionAsPrinted: string | undefined;
};

export type PlUokikRulingHeaderRead =
  | { type: "read"; header: PlUokikRulingHeader }
  | { type: "unread"; reason: PlUokikRulingUnread };

/** How far into the file the header's lines may sit. */
const HEADER_LINES = 16;

const RULING_KINDS: Readonly<Record<string, string>> = {
  WYROK: "wyrok",
  POSTANOWIENIE: "postanowienie",
  UCHWAŁA: "uchwała",
  ZARZĄDZENIE: "zarządzenie",
};

const RULING_KIND_LINE =
  /^(?<kind>WYROK|POSTANOWIENIE|UCHWAŁA|ZARZĄDZENIE)(?!\p{L})/u;

/** `Sygn. akt`, and the misprint `Sygrs. akt` a text layer sometimes holds. */
const DOCKET_LABEL = /^sy\p{L}*\.?\s*akt\s*:?\s*/iu;

/** A court docket leads with its division's numeral: `VI ACa 527/08`. */
const DIVISION_LED = /^[IVXL]{1,6} \p{L}/u;

const POLISH_MONTHS: Readonly<Record<string, string>> = {
  stycznia: "01",
  lutego: "02",
  marca: "03",
  kwietnia: "04",
  maja: "05",
  czerwca: "06",
  lipca: "07",
  sierpnia: "08",
  września: "09",
  października: "10",
  listopada: "11",
  grudnia: "12",
};

const DATE_LINE =
  /^dnia\s+(?<day>\d{1,2})\s+(?<month>\p{L}+)\s+(?<year>\d{4})/iu;

const SUPREME_COURT = "Sąd Najwyższy";

/**
 * Every court name a ruling's header can resolve to, longest first so a name
 * that extends another wins. Taken from the common courts' own index, plus
 * the Supreme Court: a phrase naming neither is not a court this reader knows.
 */
const KNOWN_COURTS: readonly string[] = [
  ...new Set([...Object.values(PL_NCOURT_COURT_NAMES), SUPREME_COURT]),
].toSorted((left, right) => right.length - left.length);

/**
 * `Ŝ` stands for `ż` in the text layer of documents typeset with a common
 * Polish font encoding (`NajwyŜszy`, `nałoŜenie`); read as what it prints.
 */
const decodePrintedLetters = (text: string): string =>
  text.replaceAll("Ŝ", "ż");

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

const dayOf = (line: string): string | undefined => {
  const groups = DATE_LINE.exec(line)?.groups;
  const month =
    POLISH_MONTHS[groups?.["month"]?.toLocaleLowerCase("pl-PL") ?? ""];
  const day = groups?.["day"];
  const year = groups?.["year"];
  if (month === undefined || day === undefined || year === undefined) {
    return undefined;
  }
  const iso = `${year}-${month}-${day.padStart(2, "0")}`;
  return parsePlainDate(iso) === null ? undefined : iso;
};

const docketOf = (line: string): string | undefined => {
  const candidate = collapse(line.replace(DOCKET_LABEL, ""));
  return DIVISION_LED.test(candidate) &&
    DECISION_DOCKET_GRAMMARS.POL.parse(candidate) !== null
    ? candidate
    : undefined;
};

type CourtRead = { court: string; divisionAsPrinted: string | undefined };

/** What a division's name is printed between: spacing and separators. */
const EDGE_CHARACTERS: ReadonlySet<string> = new Set([",", ":", "–", "-"]);

const isEdge = (character: string | undefined): boolean =>
  character !== undefined &&
  (EDGE_CHARACTERS.has(character) || character.trim().length === 0);

/** The text without the spacing and separators at either end. */
const trimEdges = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && isEdge(text[start])) {
    start += 1;
  }
  while (end > start && isEdge(text[end - 1])) {
    end -= 1;
  }
  return text.slice(start, end);
};

/** The first court the text names, where its name is one the index knows. */
const courtOf = (text: string): CourtRead | undefined => {
  const region = collapse(decodePrintedLetters(text));
  const start = region.indexOf("Sąd ");
  if (start === -1) {
    return undefined;
  }
  const court = KNOWN_COURTS.find(
    (name) =>
      region.startsWith(name, start) &&
      !/\p{L}/u.test(region.charAt(start + name.length)),
  );
  if (court === undefined) {
    return undefined;
  }
  const rest = region.slice(start + court.length);
  const seated = rest.search(/\bw\s+składzie/u);
  const division = trimEdges(
    collapse(rest.slice(0, seated === -1 ? rest.length : seated)),
  );
  return {
    court,
    divisionAsPrinted: division.length === 0 ? undefined : division,
  };
};

const lineTexts = (lines: readonly PlSnLine[]): string[] =>
  lines
    .flatMap((line) =>
      line.type === "text"
        ? [collapse(line.runs.map(({ text }) => text).join(""))]
        : [],
    )
    .filter((line) => line.length > 0);

/**
 * The court, docket, date and kind a ruling's own header states, in the
 * order a Polish judgment prints them: the docket above the kind, the date
 * under it, then the court sitting `w składzie`. Each is read from its place,
 * so a court or docket the ruling cites further down (the judgment appealed)
 * is never taken for its own.
 */
export const readPlUokikRulingHeader = (
  lines: readonly PlSnLine[],
): PlUokikRulingHeaderRead => {
  const text = lineTexts(lines).slice(0, HEADER_LINES);
  if (text.length === 0) {
    return { type: "unread", reason: PL_UOKIK_RULING_UNREAD.NO_TEXT };
  }
  const kindAt = text.findIndex((line) => RULING_KIND_LINE.test(line));
  const kind =
    RULING_KINDS[
      RULING_KIND_LINE.exec(text[kindAt] ?? "")?.groups?.["kind"] ?? ""
    ];
  if (kindAt === -1 || kind === undefined) {
    return { type: "unread", reason: PL_UOKIK_RULING_UNREAD.KIND_NOT_READ };
  }
  const caseNumber = text
    .slice(0, kindAt)
    .map(docketOf)
    .find((docket) => docket !== undefined);
  if (caseNumber === undefined) {
    return { type: "unread", reason: PL_UOKIK_RULING_UNREAD.DOCKET_NOT_READ };
  }
  const dateAt = text.findIndex(
    (line, index) => index > kindAt && dayOf(line) !== undefined,
  );
  const decisionDate = dayOf(text[dateAt] ?? "");
  if (dateAt === -1 || decisionDate === undefined) {
    return { type: "unread", reason: PL_UOKIK_RULING_UNREAD.DATE_NOT_READ };
  }
  const after = text.slice(dateAt + 1);
  const seatedAt = after.findIndex((line) => /składzie/u.test(line));
  const court =
    seatedAt === -1
      ? undefined
      : courtOf(after.slice(0, seatedAt + 1).join(" "));
  if (court === undefined) {
    return { type: "unread", reason: PL_UOKIK_RULING_UNREAD.COURT_NOT_READ };
  }
  return {
    type: "read",
    header: { decisionType: kind, caseNumber, decisionDate, ...court },
  };
};
