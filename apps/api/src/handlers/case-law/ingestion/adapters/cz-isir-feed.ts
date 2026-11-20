/**
 * The insolvency register's public action feed (ISIR_PUBLIC_WS, "WS_1").
 *
 * The register publishes every event of every insolvency file as an action
 * with a sequential id. `getIsirWsPublicIdDataRequest(idPodnetu)` answers the
 * next actions after an id (at most a page; ids are not contiguous), and
 * `getIsirWsPublicPosledniIdDataRequest` the last id published. An action
 * names its file (`spisovaZnacka`, with the court in the note's
 * `idOsobyPuvodce`), its event type (`typUdalosti`), its place in the file
 * (`oddil`, `cisloVOddilu`) and, for an event with a document, the document's
 * address. Structured data rides in `poznamka`, an XML note of its own.
 *
 * This module reads actions and nothing else: it keeps an allowlist of the
 * action's identifying fields and of the note's event fields. The note's
 * person and address records (`osoba`, `adresa`), the debtor references
 * (`idOsoby1`, `idOsoby2`, which spell a name and a birth date), the creditor
 * name of a claim (`osobaVeritel`) and free text (`obecnyText`) are never
 * read into a value, so no personal data the feed carries leaves this module.
 *
 * Documentation: https://isir.justice.cz/isir/help/Popis_WS_1_v2_10.pdf
 * (version 2.10), note schema poznamka_1_11.xsd.
 */
import { panic, Result, TaggedError } from "better-result";
import { SaxesParser } from "saxes";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
/** The feed's SOAP endpoint. */
export const CZ_ISIR_FEED_URL =
  "https://isir.justice.cz:8443/isir_public_ws/IsirWsPublicService";

/** The document servlet the feed's `dokumentUrl` values point at. */
const CZ_ISIR_DOCUMENT_URL =
  "https://isir.justice.cz:8443/isir_public_ws/doc/Document";

const TYPES_NAMESPACE = "http://isirpublicws.cca.cz/types/";

/** The first id a walk asks after: the service answers from its first action. */
export const CZ_ISIR_FEED_START_ID = -1;

/** The service answers at most this many actions per call. */
export const CZ_ISIR_FEED_PAGE_SIZE = 1000;

const envelope = (body: string): string =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="${TYPES_NAMESPACE}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

/** The request for the actions after `afterId`. */
export const czIsirActionsRequest = (afterId: number): string => {
  if (!Number.isSafeInteger(afterId) || afterId < CZ_ISIR_FEED_START_ID) {
    return panic(`Not an ISIR action id: ${afterId}`);
  }
  return envelope(
    `<typ:getIsirWsPublicIdDataRequest><idPodnetu>${afterId}</idPodnetu></typ:getIsirWsPublicIdDataRequest>`,
  );
};

/** The request for the last published action id. */
export const CZ_ISIR_LAST_ID_REQUEST = envelope(
  "<typ:getIsirWsPublicPosledniIdDataRequest/>",
);

/**
 * Event types of a high court's decision on appeal (vrchní soud), from the
 * register's event code list (Cis_udalosti.xls). The main file's appeal
 * decisions, the decision on jurisdiction, and the incidental-dispute
 * (oddíl C) decisions of the high court.
 */
const CZ_ISIR_APPELLATE_DECISION_EVENTS: ReadonlySet<number> = new Set([
  // Rozhodnutí o odvolání: potvrzeno, změněno, zrušeno a vráceno, zastavení
  // řízení, odmítnuto, jinak; zrušeno a zastaveno.
  373, 374, 375, 376, 377, 378, 629,
  // Rozhodnutí VS/NS o určení příslušnosti.
  391,
  // VS - Rozsudek / Usnesení in an incidental dispute (oddíl C).
  888, 889, 891, 892, 893, 894, 895, 896, 897, 589, 590, 904, 905, 906, 907,
]);

/** The event that makes a debtor's data inaccessible (§ 425 insolvenčního zákona). */
const CZ_ISIR_STRIKE_OFF_EVENT = 636;

const YES = "T";

/** What an action's `dokumentUrl` names. */
export const CZ_ISIR_DOCUMENT_REFERENCE = {
  /** No `dokumentUrl`: an update of the event, such as its final date. */
  NONE: "none",
  /** A document id the servlet serves. */
  DOCUMENT: "document",
  /** A `dokumentUrl` that names no document id this reader accepts. */
  MALFORMED: "malformed",
} as const;

export type CzIsirDocumentReference =
  (typeof CZ_ISIR_DOCUMENT_REFERENCE)[keyof typeof CZ_ISIR_DOCUMENT_REFERENCE];

/**
 * One action, reduced to the fields the corpus may hold. Every field the
 * service states for an action is listed in `CZ_ISIR_ACTION_FIELDS`, kept or
 * dropped with the reason.
 */
export type CzIsirAction = {
  readonly id: number;
  readonly createdAt: string | null;
  readonly publishedAt: string | null;
  /** The document id the action's `dokumentUrl` names; null without one. */
  readonly documentId: string | null;
  /** Whether `dokumentUrl` was absent, a document, or unreadable. */
  readonly documentReference: CzIsirDocumentReference;
  /** The insolvency file, e.g. `INS 10782/2023`. */
  readonly fileMark: string;
  /** The court's organisation code (`idOsobyPuvodce`), e.g. `MSPHAAB`. */
  readonly courtCode: string | null;
  readonly eventType: number;
  readonly eventDescription: string | null;
  readonly section: string | null;
  readonly sectionNumber: number | null;
  /** The note's flags and dates; see {@link CzIsirActionNote}. */
  readonly note: CzIsirActionNote;
};

/** The event fields of an action's note; no person or address field is read. */
type CzIsirActionNote = {
  readonly sideDocument: boolean;
  readonly sideEvent: boolean;
  readonly fileState: string | null;
  readonly finalOn: string | null;
  readonly cancelledAt: string | null;
  readonly correctedPublicationOn: string | null;
  /** Set on a strike-off action: the date the debtor's data stopped being public. */
  readonly struckOffOn: string | null;
};

/** The note fields read into {@link CzIsirActionNote}. */
const NOTE_FIELDS = {
  priznakAnVedlejsiDokument: "sideDocument",
  priznakAnVedlejsiUdalost: "sideEvent",
  druhStavRizeni: "fileState",
  datumPravniMoci: "finalOn",
  datumUdalostZrusena: "cancelledAt",
  datumZverejneniOpraveneUdalosti: "correctedPublicationOn",
  datumVyskrtnuti: "struckOffOn",
  idOsobyPuvodce: "courtCode",
} as const;

type NoteFieldName = keyof typeof NOTE_FIELDS;

const isNoteField = (name: string): name is NoteFieldName =>
  Object.hasOwn(NOTE_FIELDS, name);

/**
 * Note subtrees read past without keeping a byte: the person and address
 * records a service action carries, the cause-list record and the note
 * schema change record.
 */
const SKIPPED_NOTE_SUBTREES: ReadonlySet<string> = new Set([
  "osoba",
  "adresa",
  "cis_udalost",
  "poznamkaXSD",
]);

/** Action fields read into {@link CzIsirAction}; `poznamka` is read apart. */
const ACTION_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "datumZalozeniUdalosti",
  "datumZverejneniUdalosti",
  "dokumentUrl",
  "spisovaZnacka",
  "typUdalosti",
  "popisUdalosti",
  "oddil",
  "cisloVOddilu",
  "poznamka",
]);

const localName = (name: string): string => name.split(":").at(-1) ?? name;

export class CzIsirFeedParseError extends TaggedError("CzIsirFeedParseError")<{
  message: string;
}> {}

type XmlLeafVisitor = {
  /** A leaf element's trimmed text, by its local name and its open ancestors. */
  leaf: (name: string, text: string, ancestors: readonly string[]) => void;
  open?: (name: string, ancestors: readonly string[]) => void;
  close?: (name: string, ancestors: readonly string[]) => void;
  /** Ancestor names whose subtree text is dropped unread. */
  skip?: ReadonlySet<string>;
};

/** One strict pass over a document; malformed XML is an error, never a partial read. */
const walkXml = (
  xml: string,
  visitor: XmlLeafVisitor,
): Result<void, CzIsirFeedParseError> => {
  // SOAP and the note schema forbid document type declarations; refusing
  // them keeps entity expansion out of the parser.
  if (/<!doctype|<!entity/iu.test(xml)) {
    return Result.err(
      new CzIsirFeedParseError({
        message: "The response declares a document type",
      }),
    );
  }
  const stack: { name: string; text: string; hasChild: boolean }[] = [];
  const errors: Error[] = [];
  const parser = new SaxesParser();
  const skipping = () =>
    visitor.skip !== undefined &&
    stack.some(({ name }) => visitor.skip?.has(name) === true);
  parser.on("error", (error) => {
    errors.push(error);
  });
  parser.on("text", (value) => {
    const top = stack.at(-1);
    if (top !== undefined && !skipping()) {
      top.text += value;
    }
  });
  parser.on("cdata", (value) => {
    const top = stack.at(-1);
    if (top !== undefined && !skipping()) {
      top.text += value;
    }
  });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    if (parent !== undefined) {
      parent.hasChild = true;
    }
    const name = localName(tag.name);
    visitor.open?.(
      name,
      stack.map((entry) => entry.name),
    );
    stack.push({ name, text: "", hasChild: false });
  });
  parser.on("closetag", () => {
    const element = stack.pop();
    if (element === undefined) {
      return;
    }
    const ancestors = stack.map((entry) => entry.name);
    if (!element.hasChild && !skipping() && !visitor.skip?.has(element.name)) {
      visitor.leaf(element.name, element.text.trim(), ancestors);
    }
    visitor.close?.(element.name, ancestors);
  });
  const written = Result.try(() => parser.write(xml).close());
  if (Result.isError(written) || errors.length > 0) {
    return Result.err(
      new CzIsirFeedParseError({
        message: "The response is not well-formed XML",
      }),
    );
  }
  return Result.ok(undefined);
};

const EMPTY_NOTE: CzIsirActionNote & { courtCode: string | null } = {
  sideDocument: false,
  sideEvent: false,
  fileState: null,
  finalOn: null,
  cancelledAt: null,
  correctedPublicationOn: null,
  struckOffOn: null,
  courtCode: null,
};

/** The event fields of a note; its person and address records are skipped. */
const readCzIsirNote = (
  note: string,
): Result<
  CzIsirActionNote & { courtCode: string | null },
  CzIsirFeedParseError
> => {
  if (note.trim().length === 0) {
    return Result.ok(EMPTY_NOTE);
  }
  const fields = new Map<NoteFieldName, string>();
  const walked = walkXml(note, {
    skip: SKIPPED_NOTE_SUBTREES,
    leaf: (name, text) => {
      if (isNoteField(name) && text.length > 0) {
        fields.set(name, text);
      }
    },
  });
  if (Result.isError(walked)) {
    return Result.err(walked.error);
  }
  return Result.ok({
    sideDocument: fields.get("priznakAnVedlejsiDokument") === YES,
    sideEvent: fields.get("priznakAnVedlejsiUdalost") === YES,
    fileState: fields.get("druhStavRizeni") ?? null,
    finalOn: fields.get("datumPravniMoci") ?? null,
    cancelledAt: fields.get("datumUdalostZrusena") ?? null,
    correctedPublicationOn:
      fields.get("datumZverejneniOpraveneUdalosti") ?? null,
    struckOffOn: fields.get("datumVyskrtnuti") ?? null,
    courtCode: fields.get("idOsobyPuvodce") ?? null,
  });
};

const DOCUMENT_ID = /^[0-9]{1,12}$/u;

/** The document id a `dokumentUrl` names; the service's host varies by environment. */
export const czIsirDocumentIdOf = (url: string): string | null => {
  if (!URL.canParse(url)) {
    return null;
  }
  const id = new URL(url).searchParams.get("idDokument");
  return id !== null && DOCUMENT_ID.test(id) ? id : null;
};

/** The public address of a document. */
export const czIsirDocumentUrl = (documentId: string): string => {
  if (!DOCUMENT_ID.test(documentId)) {
    return panic(`Not an ISIR document id: ${documentId}`);
  }
  return `${CZ_ISIR_DOCUMENT_URL}?idDokument=${documentId}`;
};

const integerOrNull = (text: string | undefined): number | null => {
  if (text === undefined || !/^-?[0-9]{1,15}$/u.test(text)) {
    return null;
  }
  const parsed = parseIntegerToken(text);
  return Result.isOk(parsed) ? parsed.value : null;
};

const textOrNull = (text: string | undefined): string | null =>
  text === undefined || text.length === 0 ? null : text;

/** One page of the feed. */
export type CzIsirActionPage = {
  readonly actions: readonly CzIsirAction[];
  /** The highest id the page answered; null on an empty page. */
  readonly lastId: number | null;
};

/** The service's status; `CHYBA` or an error code fails the page. */
type FeedStatus = { stav: string | null; kodChyby: string | null };

const statusError = ({ stav, kodChyby }: FeedStatus) =>
  stav === "OK" && kodChyby === null
    ? null
    : new CzIsirFeedParseError({
        message: `The feed answered ${stav ?? "no status"}${kodChyby === null ? "" : ` ${kodChyby}`}`,
      });

/** The actions of one `getIsirWsPublicIdDataRequest` response. */
export const readCzIsirActionPage = (
  xml: string,
): Result<CzIsirActionPage, CzIsirFeedParseError> => {
  const raw: Map<string, string>[] = [];
  let current: Map<string, string> | null = null;
  const status: FeedStatus = { stav: null, kodChyby: null };
  const seen = { fault: false };
  const walked = walkXml(xml, {
    open: (name) => {
      if (name === "data") {
        current = new Map();
      }
      if (name === "Fault") {
        seen.fault = true;
      }
    },
    close: (name) => {
      if (name === "data" && current !== null) {
        raw.push(current);
        current = null;
      }
    },
    leaf: (name, text, ancestors) => {
      const parent = ancestors.at(-1);
      if (parent === "data" && current !== null && ACTION_FIELDS.has(name)) {
        current.set(name, text);
      }
      if (parent === "status" && name === "stav") {
        status.stav = text;
      }
      if (parent === "status" && name === "kodChyby") {
        status.kodChyby = text;
      }
    },
  });
  if (Result.isError(walked)) {
    return Result.err(walked.error);
  }
  if (seen.fault) {
    return Result.err(
      new CzIsirFeedParseError({ message: "The feed answered a SOAP fault" }),
    );
  }
  const failed = statusError(status);
  if (failed !== null) {
    return Result.err(failed);
  }
  const actions: CzIsirAction[] = [];
  for (const fields of raw) {
    const id = integerOrNull(fields.get("id"));
    const eventType = integerOrNull(fields.get("typUdalosti"));
    const fileMark = textOrNull(fields.get("spisovaZnacka"));
    if (id === null || eventType === null || fileMark === null) {
      return Result.err(
        new CzIsirFeedParseError({
          message: `An action states no id, event type or file: ${fields.get("id") ?? "?"}`,
        }),
      );
    }
    const note = readCzIsirNote(fields.get("poznamka") ?? "");
    if (Result.isError(note)) {
      return Result.err(note.error);
    }
    const { courtCode, ...event } = note.value;
    const documentUrl = textOrNull(fields.get("dokumentUrl"));
    const documentId =
      documentUrl === null ? null : czIsirDocumentIdOf(documentUrl);
    let documentReference: CzIsirDocumentReference =
      CZ_ISIR_DOCUMENT_REFERENCE.DOCUMENT;
    if (documentUrl === null) {
      documentReference = CZ_ISIR_DOCUMENT_REFERENCE.NONE;
    } else if (documentId === null) {
      documentReference = CZ_ISIR_DOCUMENT_REFERENCE.MALFORMED;
    }
    actions.push({
      id,
      createdAt: textOrNull(fields.get("datumZalozeniUdalosti")),
      publishedAt: textOrNull(fields.get("datumZverejneniUdalosti")),
      documentId,
      documentReference,
      fileMark,
      courtCode,
      eventType,
      eventDescription: textOrNull(fields.get("popisUdalosti")),
      section: textOrNull(fields.get("oddil")),
      sectionNumber: integerOrNull(fields.get("cisloVOddilu")),
      note: event,
    });
  }
  let lastId: number | null = null;
  for (const { id } of actions) {
    if (lastId === null || id > lastId) {
      lastId = id;
    }
  }
  return Result.ok({ actions, lastId });
};

/** The last published action id of a `getIsirWsPublicPosledniIdDataRequest` response. */
export const readCzIsirLastId = (
  xml: string,
): Result<number, CzIsirFeedParseError> => {
  const read: { lastId: number | null } = { lastId: null };
  const status: FeedStatus = { stav: null, kodChyby: null };
  const walked = walkXml(xml, {
    leaf: (name, text, ancestors) => {
      if (name === "cisloPosledniId") {
        read.lastId = integerOrNull(text);
      }
      if (ancestors.at(-1) === "status" && name === "stav") {
        status.stav = text;
      }
      if (ancestors.at(-1) === "status" && name === "kodChyby") {
        status.kodChyby = text;
      }
    },
  });
  if (Result.isError(walked)) {
    return Result.err(walked.error);
  }
  const failed = statusError(status);
  if (failed !== null) {
    return Result.err(failed);
  }
  return read.lastId === null
    ? Result.err(
        new CzIsirFeedParseError({ message: "The feed stated no last id" }),
      )
    : Result.ok(read.lastId);
};

/** Which decisions a walk reads. */
export const CZ_ISIR_DECISION_SCOPE = {
  /** The high courts' decisions on appeal (VSPH, VSOL). */
  APPELLATE: "appellate",
  /** Those, and the insolvency courts' own decisions. */
  APPELLATE_AND_INSOLVENCY_COURT: "appellate-and-insolvency-court",
} as const;

export type CzIsirDecisionScope =
  (typeof CZ_ISIR_DECISION_SCOPE)[keyof typeof CZ_ISIR_DECISION_SCOPE];

/** Why an action of a decision event type is not read as a decision. */
export const CZ_ISIR_ACTION_SKIP = {
  NOT_A_DECISION: "not-a-decision",
  NO_DOCUMENT: "no-document",
  /**
   * A decision whose `dokumentUrl` names no readable document id: listed,
   * but not readable, so it is counted as a failed item, never as no document.
   */
  MALFORMED_DOCUMENT_REFERENCE: "malformed-document-reference",
  SIDE_DOCUMENT: "side-document",
  CANCELLED: "cancelled",
} as const;

export type CzIsirActionSkip =
  (typeof CZ_ISIR_ACTION_SKIP)[keyof typeof CZ_ISIR_ACTION_SKIP];

/**
 * Whether an action publishes a decision's document in scope.
 *
 * A decision event answers through several actions: the decision with its
 * document, later the date it became final (`datumPravniMoci`, no document),
 * and the side documents filed under the same event (delivery receipts and
 * the court's notes, flagged `priznakAnVedlejsiDokument`). Only the first
 * carries the decision.
 */
export const czIsirDecisionAction = (
  action: CzIsirAction,
  scope: CzIsirDecisionScope,
  insolvencyCourtEvents: ReadonlySet<number>,
):
  | { type: "decision"; documentId: string }
  | { type: "skip"; reason: CzIsirActionSkip } => {
  const inScope =
    CZ_ISIR_APPELLATE_DECISION_EVENTS.has(action.eventType) ||
    (scope === CZ_ISIR_DECISION_SCOPE.APPELLATE_AND_INSOLVENCY_COURT &&
      insolvencyCourtEvents.has(action.eventType));
  if (!inScope) {
    return { type: "skip", reason: CZ_ISIR_ACTION_SKIP.NOT_A_DECISION };
  }
  if (action.note.cancelledAt !== null) {
    return { type: "skip", reason: CZ_ISIR_ACTION_SKIP.CANCELLED };
  }
  if (action.note.sideDocument) {
    return { type: "skip", reason: CZ_ISIR_ACTION_SKIP.SIDE_DOCUMENT };
  }
  if (action.documentId !== null) {
    return { type: "decision", documentId: action.documentId };
  }
  return {
    type: "skip",
    reason:
      action.documentReference === CZ_ISIR_DOCUMENT_REFERENCE.MALFORMED
        ? CZ_ISIR_ACTION_SKIP.MALFORMED_DOCUMENT_REFERENCE
        : CZ_ISIR_ACTION_SKIP.NO_DOCUMENT,
  };
};

/** The proceeding an action belongs to: its court, where stated, and its file. */
export type CzIsirProceeding = {
  readonly courtCode: string | null;
  readonly fileMark: string;
};

/** The proceedings a page strikes off the register (§ 425 insolvenčního zákona). */
export const czIsirStruckOffProceedings = (
  actions: readonly CzIsirAction[],
): CzIsirProceeding[] => {
  const seen = new Map<string, CzIsirProceeding>();
  for (const action of actions) {
    if (
      action.eventType === CZ_ISIR_STRIKE_OFF_EVENT ||
      action.note.struckOffOn !== null
    ) {
      seen.set(`${action.courtCode ?? ""}\u0000${action.fileMark}`, {
        courtCode: action.courtCode,
        fileMark: action.fileMark,
      });
    }
  }
  return [...seen.values()];
};

const proceedingKey = (courtCode: string, fileMark: string) =>
  `${courtCode}\u0000${fileMark}`;

/**
 * Whether an action belongs to a proceeding its page strikes off. Where the
 * feed omits the court on either side, the file mark alone cannot tell two
 * courts' files apart, so the action is held back with the struck-off file.
 */
export const czIsirStruckOffOnPage = (
  actions: readonly CzIsirAction[],
): ((action: CzIsirAction) => boolean) => {
  const struckOff = czIsirStruckOffProceedings(actions);
  const keyed = new Set(
    struckOff.flatMap(({ courtCode, fileMark }) =>
      courtCode === null ? [] : [proceedingKey(courtCode, fileMark)],
    ),
  );
  const marks = new Set(struckOff.map(({ fileMark }) => fileMark));
  const unkeyedMarks = new Set(
    struckOff.flatMap(({ courtCode, fileMark }) =>
      courtCode === null ? [fileMark] : [],
    ),
  );
  return ({ courtCode, fileMark }) =>
    courtCode === null
      ? marks.has(fileMark)
      : keyed.has(proceedingKey(courtCode, fileMark)) ||
        unkeyedMarks.has(fileMark);
};
