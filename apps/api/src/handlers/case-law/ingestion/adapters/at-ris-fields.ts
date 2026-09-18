/**
 * One field inventory for the eleven tribunals this publisher serves.
 *
 * The response schema states a common envelope — technical, general and
 * judicial metadata plus the document list — and one branch per application,
 * and only the branch differs between the eleven. So the common envelope and
 * the branch vocabulary are written once here, and each application declares
 * which branch fields and which printed document sections it uses. Eleven
 * hand-copied maps would state one schema eleven times and drift the first
 * time one of them was edited.
 *
 * Three vocabularies, each total by construction:
 *
 * - {@link AT_RIS_COMMON_FIELDS} over the envelope every application shares;
 * - {@link AT_RIS_BRANCH_FIELDS} over every per-application field the schema
 *   declares, from which an application names the ones it fills;
 * - {@link AT_RIS_DOCUMENT_FIELDS} over the content types the document XML
 *   labels its sections with, from which an application names the ones it
 *   prints.
 *
 * A name added to a list without a disposition does not compile, and a name
 * the publisher adds to either payload reaches `listAtRisSourceFields` as an
 * undeclared field rather than as silence.
 */

import { panic } from "better-result";

import type { DecisionTextFieldKey } from "@stll/api-contract/case-law-text-field";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { excludedSourceField } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  SourceFieldDisposition,
  SourceFieldInventory,
  SourceRawParts,
} from "@/api/handlers/case-law/ingestion/adapter";
import { listRisDocumentContentTypes } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import { isRecord } from "@/api/lib/type-guards";

/** The envelope part each payload of a decision is stored under. */
export const AT_RIS_PART = {
  LISTING: "listing",
  DOCUMENT_XML: "document-xml",
  HEADNOTE_LISTING: "headnote-listing",
} as const;

// ── The common envelope ──────────────────────────────────

/**
 * Every field the response schema states for a decision outside the
 * per-application branch, spelled as the publisher's own element path.
 */
const COMMON_SOURCE_FIELDS = [
  "Technisch/ID",
  "Technisch/Applikation",
  "Technisch/Organ",
  "Technisch/Einbringer",
  "Technisch/ImportTimestamp",
  "Allgemein/Veroeffentlicht",
  "Allgemein/Geaendert",
  "Allgemein/DokumentUrl",
  "Judikatur/Dokumenttyp",
  "Judikatur/Geschaeftszahl",
  "Judikatur/Normen",
  "Judikatur/Entscheidungsdatum",
  "Judikatur/Schlagworte",
  "Judikatur/EuropeanCaseLawIdentifier",
  "Judikatur/GesamteEntscheidungUrl",
  "Judikatur/EntscheidungstextUrl",
  "Judikatur/RechtssaetzeUrl",
  "Dokumentliste/ContentReference/ContentType",
  "Dokumentliste/ContentReference/Name",
  "Dokumentliste/ContentReference/Urls/ContentUrl/DataType",
  "Dokumentliste/ContentReference/Urls/ContentUrl/Url",
] as const;

type AtRisCommonField = (typeof COMMON_SOURCE_FIELDS)[number];

/**
 * The document list keeps one disposition for its four element names: they
 * describe one structure — which document, under which name, in which formats
 * — and the row keeps that structure whole, because it is what names the
 * images a decision embeds as well as the formats of its main document.
 */
const DOCUMENT_PARTS_TARGET = {
  disposition: "stored",
  target: { type: "metadata", key: "documentParts" },
} as const satisfies SourceFieldDisposition;

const AT_RIS_COMMON_FIELDS = {
  "Technisch/ID": { disposition: "stored", target: { type: "identity" } },
  "Technisch/Applikation": excludedSourceField(
    "the application this adapter names in its own query, restated in the answer",
  ),
  "Technisch/Organ": {
    disposition: "stored",
    target: { type: "metadata", key: "organ" },
  },
  "Technisch/Einbringer": {
    disposition: "stored",
    target: { type: "metadata", key: "submitter" },
  },
  "Technisch/ImportTimestamp": excludedSourceField(
    "nil on every search answer; only the change feed carries a value in it",
  ),
  "Allgemein/Veroeffentlicht": {
    disposition: "stored",
    target: { type: "metadata", key: "published" },
  },
  "Allgemein/Geaendert": {
    disposition: "stored",
    target: { type: "metadata", key: "modified" },
  },
  "Allgemein/DokumentUrl": {
    disposition: "stored",
    target: { type: "result", key: "sourceUrl" },
  },
  "Judikatur/Dokumenttyp": {
    disposition: "stored",
    target: { type: "metadata", key: "documentKind" },
  },
  "Judikatur/Geschaeftszahl": {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  "Judikatur/Normen": {
    disposition: "stored",
    target: { type: "metadata", key: "statutes" },
  },
  "Judikatur/Entscheidungsdatum": {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  "Judikatur/Schlagworte": {
    disposition: "stored",
    target: { type: "metadata", key: "keywords" },
  },
  "Judikatur/EuropeanCaseLawIdentifier": {
    disposition: "stored",
    target: { type: "result", key: "ecli" },
  },
  "Judikatur/GesamteEntscheidungUrl": excludedSourceField(
    "the address of a page presenting the decision and its headnotes together, both of which the row keeps as parts of their own",
  ),
  "Judikatur/EntscheidungstextUrl": {
    disposition: "stored",
    target: { type: "metadata", key: "decisionTextDocument" },
  },
  "Judikatur/RechtssaetzeUrl": excludedSourceField(
    "the address of a page listing the headnotes the row stores as a part of its own",
  ),
  "Dokumentliste/ContentReference/ContentType": DOCUMENT_PARTS_TARGET,
  "Dokumentliste/ContentReference/Name": DOCUMENT_PARTS_TARGET,
  "Dokumentliste/ContentReference/Urls/ContentUrl/DataType":
    DOCUMENT_PARTS_TARGET,
  "Dokumentliste/ContentReference/Urls/ContentUrl/Url": DOCUMENT_PARTS_TARGET,
} as const satisfies Record<AtRisCommonField, SourceFieldDisposition>;

// ── The per-application branch ───────────────────────────

/**
 * Every field the schema declares inside an application's own branch, across
 * the eleven. One vocabulary rather than eleven: the same name means the same
 * thing wherever it appears — `Anmerkung` is a notice in all four
 * applications that carry one — so a target decided once is a target decided
 * for all of them.
 */
const BRANCH_SOURCE_FIELDS = [
  "Anfechtung",
  "Anmerkung",
  "Beachte",
  "Bezug",
  "Bundesland",
  "DokumentnummerDesVwGH",
  "DokumentnummerTyp",
  "EntscheidendeBehoerde",
  "Entscheidungsart",
  "Entscheidungstexte",
  "Fachgebiete",
  "Fundstelle",
  "Gericht",
  "Gerichtsentscheidungen",
  "HinweisAufStammrechtssatz",
  "Indizes",
  "Kurzbezeichnung",
  "Kurzinformation",
  "Leitsatz",
  "Rechtsgebiete",
  "Rechtssatzkette",
  "Rechtssatznummer",
  "Rechtssatznummern",
  "Sammlungsnummer",
  "Stammrechtssatznummer",
  "Textnummern",
  "Veroeffentlichungen",
  "Verfasser",
  "Vorverfahren",
] as const;

export type AtRisBranchField = (typeof BRANCH_SOURCE_FIELDS)[number];

/**
 * Where each branch field lands. The deciding body has two names in the
 * schema — courts state `Gericht`, administrative authorities state
 * `EntscheidendeBehoerde` — and one target, because the row has one court.
 */
const AT_RIS_BRANCH_FIELDS = {
  Anfechtung: {
    disposition: "stored",
    target: { type: "metadata", key: "challenge" },
  },
  Anmerkung: {
    disposition: "stored",
    target: { type: "metadata", key: "note" },
  },
  Beachte: {
    disposition: "stored",
    target: { type: "metadata", key: "notice" },
  },
  Bezug: {
    disposition: "stored",
    target: { type: "metadata", key: "relatedDecisions" },
  },
  Bundesland: {
    disposition: "stored",
    target: { type: "metadata", key: "province" },
  },
  DokumentnummerDesVwGH: {
    disposition: "stored",
    target: { type: "metadata", key: "publisherDocumentNumber" },
  },
  DokumentnummerTyp: {
    disposition: "stored",
    target: { type: "metadata", key: "documentNumberKind" },
  },
  EntscheidendeBehoerde: {
    disposition: "stored",
    target: { type: "result", key: "court" },
  },
  Entscheidungsart: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  Entscheidungstexte: {
    disposition: "stored",
    target: { type: "metadata", key: "adoptingDecisions" },
  },
  Fachgebiete: {
    disposition: "stored",
    target: { type: "metadata", key: "specialistAreas" },
  },
  Fundstelle: {
    disposition: "stored",
    target: { type: "metadata", key: "reporterCitation" },
  },
  Gericht: { disposition: "stored", target: { type: "result", key: "court" } },
  Gerichtsentscheidungen: {
    disposition: "stored",
    target: { type: "metadata", key: "citedDecisions" },
  },
  HinweisAufStammrechtssatz: {
    disposition: "stored",
    target: { type: "metadata", key: "parentHeadnote" },
  },
  Indizes: {
    disposition: "stored",
    target: { type: "metadata", key: "subjectIndex" },
  },
  Kurzbezeichnung: {
    disposition: "stored",
    target: { type: "metadata", key: "shortName" },
  },
  Kurzinformation: {
    disposition: "stored",
    target: { type: "metadata", key: "shortInformation" },
  },
  Leitsatz: {
    disposition: "stored",
    target: { type: "textField", key: "abstract" },
  },
  Rechtsgebiete: {
    disposition: "stored",
    target: { type: "metadata", key: "legalAreas" },
  },
  Rechtssatzkette: excludedSourceField(
    "the address of a chain page on the host that answers an automated client with a challenge; the parent headnote it chains is named by an identifier the branch already states",
  ),
  Rechtssatznummer: {
    disposition: "stored",
    target: { type: "metadata", key: "headnoteNumber" },
  },
  Rechtssatznummern: {
    disposition: "stored",
    target: { type: "metadata", key: "headnoteNumbers" },
  },
  Sammlungsnummer: {
    disposition: "stored",
    target: { type: "metadata", key: "collectionNumber" },
  },
  Stammrechtssatznummer: {
    disposition: "stored",
    target: { type: "metadata", key: "parentHeadnoteDocument" },
  },
  Textnummern: {
    disposition: "stored",
    target: { type: "metadata", key: "textNumbers" },
  },
  Veroeffentlichungen: {
    disposition: "stored",
    target: { type: "metadata", key: "publications" },
  },
  Verfasser: {
    disposition: "stored",
    target: { type: "metadata", key: "author" },
  },
  Vorverfahren: {
    disposition: "stored",
    target: { type: "metadata", key: "priorProceedings" },
  },
} as const satisfies Record<AtRisBranchField, SourceFieldDisposition>;

/**
 * The element a branch field is read under, where the schema spells it
 * differently from the vocabulary above.
 *
 * One case: the chain is an address, and the `…Url` suffix that says so stays
 * out of the vocabulary the eleven applications share.
 */
export const atRisBranchElement = (field: AtRisBranchField): string =>
  field === "Rechtssatzkette" ? "RechtssatzketteUrl" : field;

// ── The printed document ─────────────────────────────────

/**
 * The content types the document XML labels its sections with.
 *
 * The publisher's own machine key for a section, not the German heading
 * printed above it: the heading is what the eleven applications spell
 * differently for one and the same section, and the key is what they share.
 */
const DOCUMENT_SOURCE_FIELDS = [
  "begruendung",
  "betreff",
  "ecli",
  "entscheidungsdatum",
  "entscheidungstexte",
  "gericht",
  "gz",
  "hinweisstrs",
  "kopf",
  "kurzbezeichnung",
  "leitsatz",
  "norm",
  "organ",
  "rechtlichebeurteilung",
  "rechtssatz",
  "rechtssatznummer",
  "spruch",
  "strs",
  "text",
] as const;

export type AtRisDocumentField = (typeof DOCUMENT_SOURCE_FIELDS)[number];

const IN_DOCUMENT = {
  disposition: "stored",
  target: { type: "document" },
} as const satisfies SourceFieldDisposition;

const AT_RIS_DOCUMENT_FIELDS = {
  begruendung: IN_DOCUMENT,
  betreff: {
    disposition: "stored",
    target: { type: "textField", key: "summary" },
  },
  ecli: excludedSourceField(
    "the listing states the identifier as a field of its own",
  ),
  entscheidungsdatum: excludedSourceField(
    "the listing states the decision date as a date",
  ),
  entscheidungstexte: {
    disposition: "stored",
    target: { type: "metadata", key: "adoptingDecisions" },
  },
  gericht: excludedSourceField(
    "the listing states the deciding body in a field of its own",
  ),
  gz: excludedSourceField("the listing states every docket of the decision"),
  hinweisstrs: {
    disposition: "stored",
    target: { type: "metadata", key: "parentHeadnote" },
  },
  kopf: IN_DOCUMENT,
  kurzbezeichnung: {
    disposition: "stored",
    target: { type: "metadata", key: "shortName" },
  },
  leitsatz: {
    disposition: "stored",
    target: { type: "textField", key: "abstract" },
  },
  norm: excludedSourceField(
    "the listing states the same provisions as a list of its own",
  ),
  organ: excludedSourceField(
    "the listing states the deciding body in a field of its own",
  ),
  rechtlichebeurteilung: IN_DOCUMENT,
  rechtssatz: {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  rechtssatznummer: {
    disposition: "stored",
    target: { type: "metadata", key: "headnoteNumber" },
  },
  spruch: IN_DOCUMENT,
  strs: {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  text: IN_DOCUMENT,
} as const satisfies Record<AtRisDocumentField, SourceFieldDisposition>;

// ── What each application fills ──────────────────────────

const DOCUMENT_FIELD_PREFIX = "Dokument/";

export type AtRisApplicationProfile = {
  /** The `Applikation` this adapter queries, and the branch element's name. */
  readonly application: string;
  readonly branch: readonly AtRisBranchField[];
  readonly document: readonly AtRisDocumentField[];
};

/**
 * Which of the schema's fields each application fills, and which sections its
 * documents print.
 *
 * Total over the eleven adapters: a tribunal registered without a profile
 * does not compile, and a profile is the only place an application's own
 * vocabulary is stated.
 */
export const AT_RIS_APPLICATIONS = {
  [ADAPTER_KEYS.AT_COURTS]: {
    application: "Justiz",
    branch: [
      "Rechtsgebiete",
      "Fachgebiete",
      "Entscheidungsart",
      "Gericht",
      "Textnummern",
      "Rechtssatznummern",
      "Anmerkung",
      "Fundstelle",
      "Entscheidungstexte",
    ],
    document: [
      "gericht",
      "entscheidungsdatum",
      "gz",
      "kopf",
      "spruch",
      "text",
      "rechtlichebeurteilung",
      "ecli",
      "rechtssatznummer",
      "norm",
      "rechtssatz",
      "entscheidungstexte",
    ],
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    application: "Vfgh",
    branch: [
      "Entscheidungsart",
      "Gericht",
      "Indizes",
      "Sammlungsnummer",
      "Beachte",
      "Leitsatz",
      "Entscheidungstexte",
    ],
    document: [
      "gericht",
      "entscheidungsdatum",
      "gz",
      "leitsatz",
      "spruch",
      "begruendung",
      "ecli",
      "rechtssatz",
    ],
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    application: "Vwgh",
    branch: [
      "Rechtssatznummer",
      "Entscheidungsart",
      "DokumentnummerTyp",
      "Stammrechtssatznummer",
      "Gericht",
      "Indizes",
      "Sammlungsnummer",
      "Beachte",
      "HinweisAufStammrechtssatz",
      "Gerichtsentscheidungen",
      "DokumentnummerDesVwGH",
      "Rechtssatzkette",
    ],
    document: [
      "gericht",
      "entscheidungsdatum",
      "gz",
      "betreff",
      "spruch",
      "begruendung",
      "ecli",
      "hinweisstrs",
      "strs",
    ],
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    application: "Bvwg",
    branch: [
      "Entscheidungsart",
      "Gericht",
      "Rechtssatznummern",
      "Bezug",
      "Anmerkung",
    ],
    document: ["gericht", "entscheidungsdatum", "gz", "spruch", "text", "ecli"],
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    application: "Lvwg",
    branch: [
      "Entscheidungsart",
      "Gericht",
      "Rechtssatznummern",
      "Indizes",
      "Fundstelle",
      "Anmerkung",
      "Bundesland",
    ],
    document: ["gericht", "entscheidungsdatum", "gz", "text", "ecli"],
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    application: "AsylGH",
    branch: ["Entscheidungsart", "Kurzinformation", "Gericht", "Indizes"],
    document: ["gericht", "entscheidungsdatum", "gz", "spruch", "text"],
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    application: "Ubas",
    branch: [
      "Entscheidungsart",
      "Kurzinformation",
      "EntscheidendeBehoerde",
      "Indizes",
      "Anfechtung",
      "Verfasser",
    ],
    document: ["organ", "entscheidungsdatum", "gz", "spruch", "text"],
  },
  [ADAPTER_KEYS.AT_UVS]: {
    application: "Uvs",
    branch: [
      "Entscheidungsart",
      "Kurzinformation",
      "Bundesland",
      "EntscheidendeBehoerde",
      "Indizes",
      "Sammlungsnummer",
      "Beachte",
    ],
    document: ["organ", "entscheidungsdatum", "gz", "spruch", "text"],
  },
  [ADAPTER_KEYS.AT_VERG]: {
    application: "Verg",
    branch: [
      "Kurzinformation",
      "Entscheidungsart",
      "EntscheidendeBehoerde",
      "Anmerkung",
      "Bezug",
      "Veroeffentlichungen",
      "Vorverfahren",
      "Anfechtung",
      "Entscheidungstexte",
    ],
    document: ["organ", "entscheidungsdatum", "gz", "text"],
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    application: "Umse",
    branch: [
      "Entscheidungsart",
      "Kurzinformation",
      "EntscheidendeBehoerde",
      "Indizes",
      "Kurzbezeichnung",
      "Bezug",
      "Anfechtung",
    ],
    document: ["organ", "entscheidungsdatum", "gz", "kurzbezeichnung", "text"],
  },
  [ADAPTER_KEYS.AT_BKS]: {
    application: "Bks",
    branch: [
      "Entscheidungsart",
      "Kurzinformation",
      "EntscheidendeBehoerde",
      "Anmerkung",
    ],
    document: ["organ", "entscheidungsdatum", "gz", "text"],
  },
} as const satisfies Record<string, AtRisApplicationProfile>;

/** The schema path a branch field is read and declared under. */
const atRisBranchFieldName = (
  application: string,
  field: AtRisBranchField,
): string => `Judikatur/${application}/${atRisBranchElement(field)}`;

/** Every field this application states, with what becomes of each. */
export const atRisSourceFields = (
  profile: AtRisApplicationProfile,
): Readonly<Record<string, SourceFieldDisposition>> => ({
  ...AT_RIS_COMMON_FIELDS,
  ...Object.fromEntries(
    profile.branch.map((field) => [
      atRisBranchFieldName(profile.application, field),
      AT_RIS_BRANCH_FIELDS[field],
    ]),
  ),
  ...Object.fromEntries(
    profile.document.map((field) => [
      `${DOCUMENT_FIELD_PREFIX}${field}`,
      AT_RIS_DOCUMENT_FIELDS[field],
    ]),
  ),
});

// ── Projecting the payloads onto the row ─────────────────

/**
 * A schema element that carries either one value or a list of them.
 *
 * An element the publisher serves empty arrives as `{ item: null }`, so the
 * nullish entries are dropped rather than stored as a list with nothing in
 * it: a row holding `[null]` reads as a publisher statement and is not one.
 */
const listedValues = (value: unknown): readonly unknown[] => {
  if (!isRecord(value)) {
    return [];
  }
  const items = value["item"];
  const listed = Array.isArray(items) ? items : [items];
  return listed.filter((item) => item !== null && item !== undefined);
};

const statedValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  const items = listedValues(value);
  return items.length === 0 ? undefined : items;
};

const statedText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** What the payloads state for one decision, keyed as the row stores it. */
export type AtRisStoredValues = {
  /** Keyed as the row stores them, for the adapter to check and emit. */
  readonly metadataValues: Readonly<Record<string, unknown>>;
  readonly textFields: Readonly<Partial<Record<DecisionTextFieldKey, string>>>;
};

type AtRisPayloadValues = {
  /** The application's own branch of the listing's judicial metadata. */
  readonly branch: Record<string, unknown> | undefined;
  /** The document's printed sections, by the content type labelling them. */
  readonly sections: Readonly<Record<string, string>>;
};

/**
 * Where every field this application states ends up, read off the same
 * dispositions the inventory declares.
 *
 * Projected from the map rather than written a second time: a field declared
 * stored at a metadata key and never written there would be a decision the
 * row does not keep, and the conformance suite would only catch it where a
 * fixture happened to state the field. Here the two cannot disagree.
 */
export const atRisStoredValues = (
  profile: AtRisApplicationProfile,
  { branch, sections }: AtRisPayloadValues,
): AtRisStoredValues => {
  const keyed = new Map<string, unknown>();
  const texts = new Map<DecisionTextFieldKey, string>();
  const store = (disposition: SourceFieldDisposition, value: unknown): void => {
    if (disposition.disposition !== "stored") {
      return;
    }
    switch (disposition.target.type) {
      case "metadata": {
        if (value !== undefined) {
          keyed.set(disposition.target.key, value);
        }
        return;
      }
      case "textField": {
        const text = statedText(value);
        if (text !== undefined) {
          texts.set(disposition.target.key, text);
        }
        return;
      }
      // A result field is a column of the row, an identity keys it, and a
      // document target reaches the row through the parsed document. All
      // three are filled by the adapter from these same payloads, so only
      // the two keyed stores are projected here.
      case "document":
      case "identity":
      case "result": {
        return;
      }
      default: {
        disposition.target satisfies never;
        return panic(
          `Unhandled RIS field target: ${JSON.stringify(disposition.target)}`,
        );
      }
    }
  };

  for (const field of profile.branch) {
    store(
      AT_RIS_BRANCH_FIELDS[field],
      statedValue(branch?.[atRisBranchElement(field)]),
    );
  }
  for (const field of profile.document) {
    store(AT_RIS_DOCUMENT_FIELDS[field], sections[field]);
  }
  return {
    metadataValues: Object.fromEntries(keyed),
    textFields: Object.fromEntries(texts),
  };
};

// ── Reading the stored envelope back ─────────────────────

const metadataGroupFields = (
  group: unknown,
  prefix: string,
): readonly string[] =>
  isRecord(group)
    ? Object.keys(group)
        .filter((key) => !key.startsWith("@"))
        .map((key) => `${prefix}${key}`)
    : [];

/**
 * The document list's own element names, as far as the payload fills them.
 *
 * Listed rather than walked: the structure repeats per document and per
 * format, and what the inventory has to account for is the four names it is
 * built from, not one entry per image a decision embeds.
 */
const documentListFields = (documentList: unknown): readonly string[] => {
  const references = isRecord(documentList)
    ? documentList["ContentReference"]
    : undefined;
  const entries = (Array.isArray(references) ? references : [references])
    .filter((entry) => isRecord(entry))
    .map((entry) => entry);
  const names: string[] = [];
  for (const entry of entries) {
    for (const key of ["ContentType", "Name"] as const) {
      const field = `Dokumentliste/ContentReference/${key}`;
      if (entry[key] !== undefined && !names.includes(field)) {
        names.push(field);
      }
    }
    const urls = isRecord(entry["Urls"]) ? entry["Urls"]["ContentUrl"] : [];
    for (const url of Array.isArray(urls) ? urls : [urls]) {
      if (!isRecord(url)) {
        continue;
      }
      for (const key of ["DataType", "Url"] as const) {
        const field = `Dokumentliste/ContentReference/Urls/ContentUrl/${key}`;
        if (url[key] !== undefined && !names.includes(field)) {
          names.push(field);
        }
      }
    }
  }
  return names;
};

/**
 * Every field the stored envelope states, read from the payloads themselves.
 *
 * Both parts, because this publisher splits a decision across two: the
 * listing states the metadata and the document XML states the sections the
 * court printed. The headnote listing is a payload of other documents in this
 * same shape, so its fields are the ones already accounted for here.
 */
export const listAtRisSourceFields = (
  profile: AtRisApplicationProfile,
  parts: SourceRawParts,
): readonly string[] => {
  const names: string[] = [];
  const listing: unknown = JSON.parse(parts[AT_RIS_PART.LISTING] ?? "null");
  const data = isRecord(listing) ? listing["Data"] : undefined;
  const metadata = isRecord(data) ? data["Metadaten"] : undefined;
  if (isRecord(metadata)) {
    names.push(
      ...metadataGroupFields(metadata["Technisch"], "Technisch/"),
      ...metadataGroupFields(metadata["Allgemein"], "Allgemein/"),
    );
    const judicial = metadata["Judikatur"];
    if (isRecord(judicial)) {
      for (const key of Object.keys(judicial)) {
        if (key === profile.application) {
          names.push(
            ...metadataGroupFields(
              judicial[key],
              `Judikatur/${profile.application}/`,
            ),
          );
          continue;
        }
        names.push(`Judikatur/${key}`);
      }
    }
  }
  if (isRecord(data)) {
    names.push(...documentListFields(data["Dokumentliste"]));
  }
  const xml = parts[AT_RIS_PART.DOCUMENT_XML];
  if (xml !== undefined) {
    names.push(
      ...listRisDocumentContentTypes(xml).map(
        (contentType) => `${DOCUMENT_FIELD_PREFIX}${contentType}`,
      ),
    );
  }
  return [...new Set(names)];
};

/**
 * What one tribunal declares about the fields its application states.
 *
 * Built here rather than at each adapter: the vocabulary, the dispositions
 * and the reader all live in this module, so an adapter states which
 * application it is and nothing else.
 */
export const atRisFieldInventory = (
  profile: AtRisApplicationProfile,
): SourceFieldInventory => ({
  status: "declared",
  fields: atRisSourceFields(profile),
  listSourceFields: (parts) => listAtRisSourceFields(profile, parts),
});
