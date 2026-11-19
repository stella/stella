/**
 * A court decision the insolvency register (isir.justice.cz) publishes, read
 * from its anonymised paragraphs.
 *
 * The register serves each decision as the court's own PDF; the adapter reads
 * its paragraphs (`pdf-bands.ts`), anonymises them and stores that text, and
 * this parser reads only what was stored. Its input is therefore never the
 * publisher's bytes: the identity below is read from text in which personal
 * data has already been replaced, and every field it reads (dockets, dates,
 * the court, the decision's kind) survives anonymisation by construction.
 *
 * What a decision states, in print order:
 *
 * - its header: the file's docket at the insolvency court and the deciding
 *   court's own (`č. j. MSPH 60 INS 10782/2023` over `3 VSPH 1361/2023-B-24`;
 *   for an incidental dispute `24 ICm 2849/2023` over `103 VSPH 257/2026-103`
 *   and the file in parentheses);
 * - its kind, as a heading of its own (`USNESENÍ`, `ROZSUDEK`), under
 *   `ČESKÁ REPUBLIKA` and over `JMÉNEM REPUBLIKY` for a judgment;
 * - the court's introduction, the operative part after `takto:`, the
 *   reasons (`Odůvodnění:`), the instruction (`Poučení:`);
 * - the place and date it was given (`Praha 22. února 2024`, `V Olomouci dne
 *   1. 2. 2024`) over the signature.
 *
 * Headings are read from typesetting: a short paragraph set wholly in bold.
 */
import { panic, Result, TaggedError } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { CZ_ECLI_COURT_REGISTRY } from "@stll/api-contract/case-law-courts";
import { declareFingerprintFields } from "@stll/errors";
// parser-output-unchanged: imports the document AST from its package owner
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { positionalBlockAnchor } from "@stll/legal-ast/stable-block-anchors";
import { Temporal } from "@stll/time";

import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import {
  CZ_ISIR_INSTANCE,
  type CzIsirInstance,
} from "@/api/lib/legal-search/cz-isir-decision";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";

const SOURCE_SYSTEM = "isir.justice.cz";

/** The text of one paragraph, and whether it is set wholly in bold. */
export type CzIsirParagraph = {
  readonly text: string;
  readonly bold: boolean;
};

export class CzIsirParseError extends TaggedError("CzIsirParseError")<{
  message: string;
  reason: CzIsirParseFailure;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/** Why a stored document is not a decision this source can key. */
export const CZ_ISIR_PARSE_FAILURE = {
  EMPTY: "empty",
  NO_DOCKET: "no-docket",
  NO_DECISION_TYPE: "no-decision-type",
  NO_DECISION_DATE: "no-decision-date",
  UNKNOWN_COURT: "unknown-court",
} as const;

export type CzIsirParseFailure =
  (typeof CZ_ISIR_PARSE_FAILURE)[keyof typeof CZ_ISIR_PARSE_FAILURE];

/** The identity a decision states about itself. */
type CzIsirDecisionIdentity = {
  readonly instance: CzIsirInstance;
  /** `3 VSPH 1361/2023`, `38 INS 1234/2011`, `24 ICm 2849/2023`. */
  readonly caseNumber: string;
  /** The sheet a numeric suffix names (`103 VSPH 257/2026-103`). */
  readonly sheetNumber: string | undefined;
  /** The file position a suffix with a section names (`B-24`). */
  readonly filePosition: string | undefined;
  readonly court: string;
  readonly decisionType: string;
  readonly decisionDate: string;
  /** The insolvency file the header names, e.g. `MSPH 60 INS 10782/2023`. */
  readonly insolvencyFile: string | undefined;
};

export type CzIsirParsedDecision = {
  identity: CzIsirDecisionIdentity;
  documentAst: DocumentAst;
  fulltext: string;
  sections: DecisionSection[] | undefined;
};

const HIGH_COURTS = {
  VSPH: CZ_ECLI_COURT_REGISTRY.VSPH.name,
  VSOL: CZ_ECLI_COURT_REGISTRY.VSOL.name,
} as const;

const isHighCourt = (code: string): code is keyof typeof HIGH_COURTS =>
  Object.hasOwn(HIGH_COURTS, code);

type RegisteredCourt = keyof typeof CZ_ECLI_COURT_REGISTRY;

const isRegisteredCourt = (code: string): code is RegisteredCourt =>
  Object.hasOwn(CZ_ECLI_COURT_REGISTRY, code);

/**
 * The register marks a regional court's branch by the branch's own town
 * (`KSLB 87 INS 984/2026`, Liberec); the court registry names it under its
 * court (`KSULLI`).
 */
const ISIR_BRANCH_COURTS: ReadonlyMap<string, RegisteredCourt> = new Map([
  ["KSLB", "KSULLI"],
  ["KSPA", "KSHKPA"],
  ["KSTA", "KSCBTA"],
  ["KSZL", "KSBRZL"],
  ["KSOL", "KSOSOL"],
]);

const registeredCourtOf = (code: string): RegisteredCourt | null =>
  ISIR_BRANCH_COURTS.get(code) ?? (isRegisteredCourt(code) ? code : null);

const DASH = "[-‐‑‒–—]";

/** A high court's senate mark: `3 VSPH 1361/2023-B-24`, `103 VSPH 257/2026-103`. */
const HIGH_COURT_DOCKET = new RegExp(
  String.raw`(?<![\p{L}\d])(?<senate>\d{1,4}) ?(?<court>VSPH|VSOL) (?<number>\d{1,7})\/(?<year>\d{4})(?: ?${DASH} ?(?:(?<section>[A-Z]{1,3}) ?${DASH} ?)?(?<sheet>\d{1,5}))?`,
  "u",
);

/** An insolvency file with its court: `MSPH 60 INS 10782/2023-B-11`. */
const INSOLVENCY_FILE = new RegExp(
  String.raw`(?<![\p{L}\d])(?<court>(?:K|M)S[A-Z]{2}) (?<senate>\d{1,4}) INS (?<number>\d{1,7})\/(?<year>\d{4})(?: ?${DASH} ?(?<section>[A-Z]{1,3}) ?${DASH} ?(?<sheet>\d{1,5}))?`,
  "u",
);

/** An incidental dispute: `24 ICm 2849/2023-78`. */
const INCIDENTAL_DISPUTE = new RegExp(
  String.raw`(?<![\p{L}\d])(?<senate>\d{1,4}) ICm (?<number>\d{1,7})\/(?<year>\d{4})(?: ?${DASH} ?(?<sheet>\d{1,5}))?`,
  "u",
);

/** The kinds a decision's own heading states, as stored (lower case). */
const DECISION_HEADINGS = [
  ["USNESENÍ", "usnesení"],
  ["ROZSUDEK", "rozsudek"],
  ["PLATEBNÍ ROZKAZ", "platební rozkaz"],
  ["SMĚNEČNÝ PLATEBNÍ ROZKAZ", "směnečný platební rozkaz"],
] as const;

const MONTH_NAMES = [
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
] as const;

type MonthName = (typeof MONTH_NAMES)[number];

const isMonthName = (name: string): name is MonthName =>
  MONTH_NAMES.some((month) => month === name);

const MONTHS = {
  ledna: 1,
  února: 2,
  března: 3,
  dubna: 4,
  května: 5,
  června: 6,
  července: 7,
  srpna: 8,
  září: 9,
  října: 10,
  listopadu: 11,
  prosince: 12,
} as const satisfies Record<MonthName, number>;

/**
 * The place and date a decision was given: `Praha 22. února 2024`,
 * `V Olomouci dne 1. 2. 2024`. A paragraph of its own above the signature.
 */
const GIVEN_ON =
  /^(?:V(?:e)? )?\p{Lu}[\p{L}]+(?: (?:nad|pod)? ?\p{Lu}?[\p{L}]+){0,3},? (?:dne )?(?<day>\d{1,2})\. ?(?<month>\d{1,2}\.|\p{Ll}+) ?(?<year>\d{4})$/u;

const isoDate = (year: number, month: number, day: number): string | null =>
  Result.try(() =>
    Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" }),
  )
    .map((date) => date.toString())
    .unwrapOr(null);

/**
 * A run of digits as its number. Every caller has matched the text against a
 * bounded digit pattern first, so a failed parse is an impossible state.
 */
const integerOf = (digits: string): number => {
  const parsed = parseIntegerToken(digits, { sign: "unsigned" });
  return Result.isOk(parsed)
    ? parsed.value
    : panic(`validated digits did not parse: ${digits}`);
};

const givenOn = (paragraph: string): string | null => {
  const groups = GIVEN_ON.exec(paragraph.trim())?.groups;
  if (groups === undefined) {
    return null;
  }
  const monthText = groups["month"] ?? "";
  let month: number | undefined;
  if (monthText.endsWith(".")) {
    month = integerOf(monthText.slice(0, -1));
  } else if (isMonthName(monthText)) {
    month = MONTHS[monthText];
  }
  return month === undefined
    ? null
    : isoDate(
        integerOf(groups["year"] ?? ""),
        month,
        integerOf(groups["day"] ?? ""),
      );
};

/** A heading: a short paragraph the publisher set wholly in bold. */
const HEADING_MAX_LENGTH = 80;

const isHeading = ({ text, bold }: CzIsirParagraph): boolean =>
  bold && text.trim().length > 0 && text.trim().length <= HEADING_MAX_LENGTH;

/** The paragraphs before the first heading after the header: where dockets stand. */
const HEADER_PARAGRAPHS = 4;

type DocketGroups = Readonly<Record<string, string | undefined>>;

/** A group the docket pattern always captures. */
const part = (groups: DocketGroups, name: string): string =>
  groups[name] ?? panic(`A matched docket lacks its ${name}`);

const failure = (reason: CzIsirParseFailure, message: string) =>
  Result.err(new CzIsirParseError({ reason, message }));

const readIdentity = (
  paragraphs: readonly CzIsirParagraph[],
  documentId: string,
): Result<CzIsirDecisionIdentity, CzIsirParseError> => {
  // The dockets stand above the decision's own heading; a docket below it
  // names another decision (the one appealed, a related file).
  const headingAt = paragraphs
    .slice(0, HEADER_PARAGRAPHS + 2)
    .findIndex(({ text }) =>
      DECISION_HEADINGS.some(
        ([heading]) => text.trim().toLocaleUpperCase("cs") === heading,
      ),
    );
  if (headingAt === -1) {
    return failure(
      CZ_ISIR_PARSE_FAILURE.NO_DECISION_TYPE,
      `Document ${documentId} states no decision heading`,
    );
  }
  const headingText = paragraphs[headingAt]?.text
    .trim()
    .toLocaleUpperCase("cs");
  const decisionType = DECISION_HEADINGS.find(
    ([heading]) => heading === headingText,
  )?.[1];
  if (decisionType === undefined) {
    return panic("A decision heading matched no kind");
  }
  const header = paragraphs
    .slice(0, headingAt)
    .map(({ text }) => text)
    .join(" ");
  const highCourt = HIGH_COURT_DOCKET.exec(header)?.groups;
  const file = INSOLVENCY_FILE.exec(header)?.groups;
  const dispute = INCIDENTAL_DISPUTE.exec(header)?.groups;
  // The first place and date after the heading closes the decision; a later
  // one dates a certified copy (`Za správnost vyhotovení`), not the decision.
  const decisionDate = paragraphs
    .slice(headingAt + 1)
    .map(({ text }) => givenOn(text))
    .find((date) => date !== null);
  if (decisionDate === undefined) {
    return failure(
      CZ_ISIR_PARSE_FAILURE.NO_DECISION_DATE,
      `Document ${documentId} states no date it was given`,
    );
  }
  const insolvencyFile =
    file === undefined
      ? undefined
      : `${part(file, "court")} ${part(file, "senate")} INS ${part(file, "number")}/${part(file, "year")}`;

  if (highCourt !== undefined) {
    const code = part(highCourt, "court");
    if (!isHighCourt(code)) {
      return failure(
        CZ_ISIR_PARSE_FAILURE.UNKNOWN_COURT,
        `Document ${documentId} names an unknown high court`,
      );
    }
    const section = highCourt["section"];
    const sheet = highCourt["sheet"];
    return Result.ok({
      instance: CZ_ISIR_INSTANCE.APPELLATE,
      caseNumber: `${part(highCourt, "senate")} ${code} ${part(highCourt, "number")}/${part(highCourt, "year")}`,
      sheetNumber: section === undefined ? sheet : undefined,
      filePosition:
        section === undefined || sheet === undefined
          ? undefined
          : `${section}-${sheet}`,
      court: HIGH_COURTS[code],
      decisionType,
      decisionDate,
      insolvencyFile,
    });
  }
  // An insolvency court's own decision: its file, or its incidental dispute.
  if (file === undefined) {
    return failure(
      CZ_ISIR_PARSE_FAILURE.NO_DOCKET,
      `Document ${documentId} states no docket`,
    );
  }
  const courtCode = registeredCourtOf(part(file, "court"));
  if (courtCode === null) {
    return failure(
      CZ_ISIR_PARSE_FAILURE.UNKNOWN_COURT,
      `Document ${documentId} names an unregistered court`,
    );
  }
  const court = CZ_ECLI_COURT_REGISTRY[courtCode].name;
  if (dispute !== undefined) {
    return Result.ok({
      instance: CZ_ISIR_INSTANCE.INSOLVENCY_COURT,
      caseNumber: `${part(dispute, "senate")} ICm ${part(dispute, "number")}/${part(dispute, "year")}`,
      sheetNumber: dispute["sheet"],
      filePosition: undefined,
      court,
      decisionType,
      decisionDate,
      insolvencyFile,
    });
  }
  const section = file["section"];
  const sheet = file["sheet"];
  return Result.ok({
    instance: CZ_ISIR_INSTANCE.INSOLVENCY_COURT,
    caseNumber: `${part(file, "senate")} INS ${part(file, "number")}/${part(file, "year")}`,
    sheetNumber: undefined,
    filePosition:
      section === undefined || sheet === undefined
        ? undefined
        : `${section}-${sheet}`,
    court,
    decisionType,
    decisionDate,
    insolvencyFile,
  });
};

const blocksOf = (paragraphs: readonly CzIsirParagraph[]): Block[] =>
  paragraphs
    .filter(({ text }) => text.trim().length > 0)
    .map((paragraph, index): Block => {
      const position = index + 1;
      const plainText = paragraph.text.trim();
      const inlines = [{ type: "text" as const, text: plainText }];
      return isHeading(paragraph)
        ? {
            id: `b${position}`,
            anchorId: positionalBlockAnchor({ kind: "h", ordinal: position }),
            type: "heading",
            level: 1,
            role: "section-heading",
            inlines,
            plainText,
          }
        : {
            id: `b${position}`,
            anchorId: positionalBlockAnchor({ kind: "p", ordinal: position }),
            type: "paragraph",
            inlines,
            plainText,
          };
    });

/** The decision a stored, anonymised document is; or why it is none. */
export const parseCzIsirDecision = (
  paragraphs: readonly CzIsirParagraph[],
  { documentId, sourceUrl }: { documentId: string; sourceUrl: string },
): Result<CzIsirParsedDecision, CzIsirParseError> => {
  if (!paragraphs.some(({ text }) => text.trim().length > 0)) {
    return failure(
      CZ_ISIR_PARSE_FAILURE.EMPTY,
      `Document ${documentId} holds no text`,
    );
  }
  const identity = readIdentity(paragraphs, documentId);
  if (Result.isError(identity)) {
    return Result.err(identity.error);
  }
  const { caseNumber, court, decisionDate, decisionType } = identity.value;
  const blocks = courtParagraphNumbers(blocksOf(paragraphs), {
    parser: SOURCE_SYSTEM,
    caseNumber,
    url: sourceUrl,
  });
  return Result.ok({
    identity: identity.value,
    documentAst: {
      version: 1,
      source: {
        system: SOURCE_SYSTEM,
        documentId,
        webUrl: sourceUrl,
        printUrl: "",
      },
      metadata: {
        caseNumber,
        ecli: null,
        court,
        decisionDate,
        decisionType,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    fulltext: blocks.map((block) => block.plainText).join("\n\n"),
    sections: blocks.some((block) => block.type === "heading")
      ? sectionsFromAst(blocks)
      : undefined,
  });
};
