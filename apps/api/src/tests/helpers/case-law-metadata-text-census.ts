import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { AT_RIS_APPLICATIONS } from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
/**
 * What the display-text residue census does with every metadata key an
 * enrolled adapter's fixture emits.
 *
 * The census walks display strings at every depth; URL exclusions come from
 * the producer's exact address declarations, preserved through projection. The map is
 * total over the keys the fixtures exercise and checked in both directions by
 * `source-field-inventory.test.ts`: a key an adapter starts emitting fails the
 * census until it is classified, and a key no fixture emits any longer fails
 * until it is dropped. A key is excluded only when its value is deliberately
 * not display text: a link that must stay byte-exact to resolve, or an opaque
 * publisher identifier stored as the publisher spells it.
 */
import {
  metadataUrlKeys,
  metadataUrlChildSchema,
  metadataUrlItemSchema,
  META_URL_DIAGNOSTICS,
} from "@/api/lib/legal-search/metadata-urls";
import { isRecord } from "@/api/lib/type-guards";

type MetadataTextDisposition =
  | {
      type: "inspected";
    }
  | { type: "excluded"; reason: string };

const PUBLISHER_ID =
  "an opaque publisher identifier, stored as the publisher spells it";

const INSPECTED = {
  type: "inspected",
} as const satisfies MetadataTextDisposition;

const excluded = (reason: string): MetadataTextDisposition => ({
  type: "excluded",
  reason,
});

export const METADATA_TEXT_DISPOSITIONS = {
  abstractCelex: excluded(PUBLISHER_ID),
  abstractState: INSPECTED,
  additionalCaseNumbers: INSPECTED,
  administrativeAuthority: INSPECTED,
  adoptingDecisions: INSPECTED,
  affectedAuthority: INSPECTED,
  affectedDocs: INSPECTED,
  affectedLegalRegulation: INSPECTED,
  affectingDocs: INSPECTED,
  analysisResultId: excluded(PUBLISHER_ID),
  announcedOn: INSPECTED,
  appealed: INSPECTED,
  appealFrom: INSPECTED,
  appealRulings: INSPECTED,
  appealWatch: INSPECTED,
  archivePath: INSPECTED,
  area: INSPECTED,
  attachments: excluded(
    "publisher FileType descriptors (fileName, fileType, bytes, status, access code); captured attachments state no URL address",
  ),
  attorneys: INSPECTED,
  author: INSPECTED,
  authorities: INSPECTED,
  authorityIds: excluded(PUBLISHER_ID),
  availableFrom: INSPECTED,
  bench: INSPECTED,
  benchAsPrinted: INSPECTED,
  bhgyIdentifier: INSPECTED,
  bipCommentNote: INSPECTED,
  bipComments: INSPECTED,
  caseDocuments: INSPECTED,
  caseEventWorks: INSPECTED,
  caseId: excluded(PUBLISHER_ID),
  caseIdentifier: INSPECTED,
  caseLawDirectory: INSPECTED,
  caseLawDirectoryNew: INSPECTED,
  caseLawSubjectMatter: INSPECTED,
  caseName: INSPECTED,
  caseNameFull: INSPECTED,
  caseNameShort: INSPECTED,
  caseNumber: INSPECTED,
  caseNumberParts: INSPECTED,
  caseResultType: INSPECTED,
  cases: INSPECTED,
  caseStatus: INSPECTED,
  caseSubject: INSPECTED,
  caseSymbols: INSPECTED,
  caseType: INSPECTED,
  category: INSPECTED,
  cause: INSPECTED,
  cdmType: INSPECTED,
  celex: excluded(PUBLISHER_ID),
  celexType: INSPECTED,
  chairman: INSPECTED,
  challenge: INSPECTED,
  challengedAct: INSPECTED,
  challengedAuthority: INSPECTED,
  challengedLegislation: INSPECTED,
  challengedProvisions: INSPECTED,
  chamber: INSPECTED,
  chambers: INSPECTED,
  citation: INSPECTED,
  citedDecisions: INSPECTED,
  citedProvisions: INSPECTED,
  clarificationOfLegalRegulation: INSPECTED,
  collection: INSPECTED,
  collectionEntry: INSPECTED,
  collectionNumber: INSPECTED,
  collectionPeriod: INSPECTED,
  combinedNomenclature: INSPECTED,
  combinedNomenclatureIds: excluded(PUBLISHER_ID),
  constitutionalProvisions: INSPECTED,
  constitutionalStandards: INSPECTED,
  contentFormats: INSPECTED,
  contentType: INSPECTED,
  contractingAuthority: INSPECTED,
  contractingAuthorityCity: INSPECTED,
  contractType: INSPECTED,
  converterVersion: INSPECTED,
  coReporters: INSPECTED,
  correction: INSPECTED,
  court: INSPECTED,
  courtAlias: INSPECTED,
  courtAsPublished: INSPECTED,
  courtBranch: INSPECTED,
  courtCases: INSPECTED,
  courtClassification: INSPECTED,
  courtCode: INSPECTED,
  courtEra: INSPECTED,
  courtFileId: excluded(PUBLISHER_ID),
  courtId: excluded(PUBLISHER_ID),
  courtKnown: INSPECTED,
  courtLevel: INSPECTED,
  courtListener: INSPECTED,
  courtRegistreGuid: excluded(PUBLISHER_ID),
  courtRegistry: INSPECTED,
  courtReporters: INSPECTED,
  courtSeat: INSPECTED,
  courtStatedBy: INSPECTED,
  courtStatus: INSPECTED,
  courtSuccession: INSPECTED,
  courtType: INSPECTED,
  crossReference: INSPECTED,
  dataset: INSPECTED,
  dateFiled: INSPECTED,
  dateOfLastUpdate: INSPECTED,
  dateOfPublication: INSPECTED,
  decision: INSPECTED,
  decisionDate: INSPECTED,
  decisionDateAsListed: INSPECTED,
  decisionDateAsPrinted: INSPECTED,
  decisionDateSource: INSPECTED,
  decisionFiles: INSPECTED,
  decisionForm: INSPECTED,
  decisionKind: INSPECTED,
  decisionKindId: excluded(PUBLISHER_ID),
  decisionLanguage: INSPECTED,
  decisionNature: INSPECTED,
  decisionNumber: INSPECTED,
  decisionNumberAsListed: INSPECTED,
  decisionTextDocument: INSPECTED,
  decisionType: INSPECTED,
  decisionTypeKey: INSPECTED,
  decisionTypeRaw: INSPECTED,
  decisionYear: INSPECTED,
  defendant: INSPECTED,
  defendantProceedingFileNumber: INSPECTED,
  department: INSPECTED,
  departmentId: excluded(PUBLISHER_ID),
  detailReadState: INSPECTED,
  detailStatus: INSPECTED,
  diagnostics: INSPECTED,
  disposition: INSPECTED,
  dissentingOnDecision: INSPECTED,
  dissentingOnReasons: INSPECTED,
  dissentingOpinion: INSPECTED,
  dissentingOpinions: INSPECTED,
  division: INSPECTED,
  docketAsPublished: INSPECTED,
  docketDates: INSPECTED,
  docketNumberCore: INSPECTED,
  docketNumberRaw: INSPECTED,
  docketRangeMembers: INSPECTED,
  docketRecognised: INSPECTED,
  doctrine: INSPECTED,
  docType: INSPECTED,
  document: INSPECTED,
  documentContentType: INSPECTED,
  documentDocket: INSPECTED,
  documentExtension: INSPECTED,
  documentFileId: excluded(PUBLISHER_ID),
  documentFrom: INSPECTED,
  documentId: excluded(PUBLISHER_ID),
  documentKind: INSPECTED,
  documentName: INSPECTED,
  documentNumberKind: INSPECTED,
  documentParts: INSPECTED,
  documentSupplements: INSPECTED,
  documentSize: INSPECTED,
  documentStatus: INSPECTED,
  documentTitle: INSPECTED,
  documentType: INSPECTED,
  documentTypes: INSPECTED,
  dossier: INSPECTED,
  ecli: INSPECTED,
  ecliAvailability: INSPECTED,
  ecliCounter: INSPECTED,
  entities: INSPECTED,
  entryDate: INSPECTED,
  eurekaId: excluded(PUBLISHER_ID),
  exciseProductKind: INSPECTED,
  externalIds: excluded(PUBLISHER_ID),
  filedDate: INSPECTED,
  filedOn: INSPECTED,
  filedStkDate: INSPECTED,
  fileReference: INSPECTED,
  finality: INSPECTED,
  findokGid: excluded(PUBLISHER_ID),
  flags: INSPECTED,
  form: INSPECTED,
  formexAuthors: INSPECTED,
  formexCelex: excluded(PUBLISHER_ID),
  formexEcli: INSPECTED,
  formOfEntry: INSPECTED,
  formOfProposer: INSPECTED,
  glossInformation: INSPECTED,
  guid: excluded(PUBLISHER_ID),
  handlingUnit: INSPECTED,
  headnoteNumber: INSPECTED,
  headnoteNumbers: INSPECTED,
  headnotes: INSPECTED,
  headnoteStatutes: INSPECTED,
  history: INSPECTED,
  href: INSPECTED,
  identifikacneCislo: excluded(PUBLISHER_ID),
  identityKind: INSPECTED,
  includeToZnaU: INSPECTED,
  industries: INSPECTED,
  inFindokSince: INSPECTED,
  ingestion: INSPECTED,
  instanceChainLines: INSPECTED,
  interprets: INSPECTED,
  issuedBy: INSPECTED,
  issuedByTitle: INSPECTED,
  issueIds: excluded(PUBLISHER_ID),
  issues: INSPECTED,
  joinedCases: INSPECTED,
  judge: INSPECTED,
  judgeAttribution: INSPECTED,
  judgeRegistreGuid: excluded(PUBLISHER_ID),
  judges: INSPECTED,
  judgmentForm: INSPECTED,
  judgmentResult: INSPECTED,
  kategorieRozhodnuti: INSPECTED,
  keywordIds: excluded(PUBLISHER_ID),
  keywords: INSPECTED,
  kind: INSPECTED,
  kindOfOtherProposer: INSPECTED,
  kollegiums: INSPECTED,
  languages: INSPECTED,
  languageUri: INSPECTED,
  lastUpdate: INSPECTED,
  lawReportsNumber: INSPECTED,
  legalArea: INSPECTED,
  legalAreas: INSPECTED,
  legalBases: INSPECTED,
  legalBasis: INSPECTED,
  legalForceDate: INSPECTED,
  legalReferences: INSPECTED,
  legalStateAsOf: INSPECTED,
  linkedRulings: INSPECTED,
  lodgedOn: INSPECTED,
  lowerCourtJudgments: INSPECTED,
  manifestations: INSPECTED,
  manifestationUri: INSPECTED,
  meansOfAppeal: INSPECTED,
  mentionedStatutes: INSPECTED,
  metadataTable: INSPECTED,
  modified: INSPECTED,
  modifiedDate: INSPECTED,
  nalusRecordId: excluded(PUBLISHER_ID),
  nalusSz: INSPECTED,
  nationalJudgment: INSPECTED,
  natureOfSuit: INSPECTED,
  normalizedValues: INSPECTED,
  note: INSPECTED,
  noteId: excluded(PUBLISHER_ID),
  notice: INSPECTED,
  noticeCelex: excluded(PUBLISHER_ID),
  noticeCourtCodes: INSPECTED,
  noticeDecisionDates: INSPECTED,
  noticeEcli: INSPECTED,
  observations: INSPECTED,
  ocr: INSPECTED,
  officialCollection: INSPECTED,
  officiallyPublished: INSPECTED,
  officialPublication: INSPECTED,
  ojNotice: INSPECTED,
  opinionAttribution: INSPECTED,
  organ: INSPECTED,
  originalCaseNumber: INSPECTED,
  originatesFrom: INSPECTED,
  originCaseNumber: INSPECTED,
  originCourt: INSPECTED,
  originCourtRegistreGuid: excluded(PUBLISHER_ID),
  otherDates: INSPECTED,
  otherProvisions: INSPECTED,
  otherSourceUrl: INSPECTED,
  outcome: INSPECTED,
  panel: INSPECTED,
  panelType: INSPECTED,
  parallelCitationLaws: INSPECTED,
  parallelCitationReports: INSPECTED,
  parallelQuotation: INSPECTED,
  parentDecisionKind: INSPECTED,
  parentHeadnote: INSPECTED,
  parentHeadnoteDocument: excluded(PUBLISHER_ID),
  parties: INSPECTED,
  parts: INSPECTED,
  penalty: INSPECTED,
  personnelType: INSPECTED,
  petitioner: INSPECTED,
  pkob: INSPECTED,
  pkobIds: excluded(PUBLISHER_ID),
  pkwiu: INSPECTED,
  pkwiuIds: excluded(PUBLISHER_ID),
  popularName: INSPECTED,
  portalEventId: excluded(PUBLISHER_ID),
  portalModifiedAt: INSPECTED,
  posture: INSPECTED,
  practices: INSPECTED,
  precedentialStatus: INSPECTED,
  presiding: INSPECTED,
  priorProceedings: INSPECTED,
  proceduralHistory: INSPECTED,
  procedure: INSPECTED,
  procedureLanguage: INSPECTED,
  procedureType: INSPECTED,
  proceedingSubject: INSPECTED,
  proceedingType: INSPECTED,
  province: INSPECTED,
  provisionIds: excluded(PUBLISHER_ID),
  provisions: INSPECTED,
  publication: INSPECTED,
  publicationDate: INSPECTED,
  publications: INSPECTED,
  publicator: INSPECTED,
  publicDefendant: INSPECTED,
  published: INSPECTED,
  publishedAt: INSPECTED,
  publishedCaseNumber: INSPECTED,
  publishedDate: INSPECTED,
  publishedInCollection: INSPECTED,
  publishedInReports: INSPECTED,
  publisher: INSPECTED,
  publisherBlocked: INSPECTED,
  publisherCaseNumber: INSPECTED,
  publisherCourt: INSPECTED,
  publisherDates: INSPECTED,
  publisherDocumentNumber: INSPECTED,
  publisherSource: INSPECTED,
  quarantineReason: INSPECTED,
  rapporteur: INSPECTED,
  reasonsAuthor: INSPECTED,
  receiptDate: INSPECTED,
  recordCard: INSPECTED,
  recordClass: INSPECTED,
  recorder: INSPECTED,
  recordVersion: INSPECTED,
  referencedCourtCases: INSPECTED,
  referencedLegislation: INSPECTED,
  referencedRegulations: INSPECTED,
  references: INSPECTED,
  referringCountry: INSPECTED,
  regions: INSPECTED,
  register: INSPECTED,
  registeredAt: INSPECTED,
  regulations: INSPECTED,
  relatedDecisions: INSPECTED,
  relatedDocuments: INSPECTED,
  relatedProceedings: INSPECTED,
  reporterCitation: INSPECTED,
  reporters: INSPECTED,
  reportsPages: INSPECTED,
  reportsReference: INSPECTED,
  reportsSequence: INSPECTED,
  resources: INSPECTED,
  result: INSPECTED,
  reviser: INSPECTED,
  rulingKeys: INSPECTED,
  rulingType: INSPECTED,
  rvpNumber: INSPECTED,
  saosId: excluded(PUBLISHER_ID),
  scdb: INSPECTED,
  senate: INSPECTED,
  sheetNumber: INSPECTED,
  shortInformation: INSPECTED,
  shortName: INSPECTED,
  signalledCase: INSPECTED,
  signedOnAuthority: INSPECTED,
  significance: INSPECTED,
  solver: INSPECTED,
  source: INSPECTED,
  sourceAttribution: INSPECTED,
  sourceUrlStatus: INSPECTED,
  specialistAreas: INSPECTED,
  specialType: INSPECTED,
  stage: INSPECTED,
  stammNr: INSPECTED,
  statedSourceUrl: INSPECTED,
  status: INSPECTED,
  statusId: excluded(PUBLISHER_ID),
  statusLabel: INSPECTED,
  statutes: INSPECTED,
  subArea: INSPECTED,
  structure: INSPECTED,
  subject: INSPECTED,
  subjectCodes: INSPECTED,
  subjectIndex: INSPECTED,
  subjectMatter: INSPECTED,
  subjectOfProceeding: INSPECTED,
  subjectTerms: INSPECTED,
  submitter: INSPECTED,
  taxes: INSPECTED,
  taxTags: INSPECTED,
  templateId: excluded(PUBLISHER_ID),
  templateVersionId: excluded(PUBLISHER_ID),
  textComplete: INSPECTED,
  textNumbers: INSPECTED,
  textSections: INSPECTED,
  textSelection: INSPECTED,
  textSource: INSPECTED,
  title: INSPECTED,
  transferredTo: INSPECTED,
  typeOfDecision: INSPECTED,
  typeOfEntry: INSPECTED,
  typeOfNegotiation: INSPECTED,
  typeOfProceeding: INSPECTED,
  typeOfProposer: INSPECTED,
  underage: INSPECTED,
  unid: excluded(PUBLISHER_ID),
  unlabelledFields: INSPECTED,
  updateDate: INSPECTED,
  updateDateDefect: INSPECTED,
  updateDateIso: INSPECTED,
  ustavniStiznost: INSPECTED,
  validFrom: INSPECTED,
  validUntil: INSPECTED,
  versionId: excluded(PUBLISHER_ID),
  versionNumber: INSPECTED,
  violator: INSPECTED,
  volumeOfLawReports: INSPECTED,
  webTitle: INSPECTED,
  wordDocumentUrl: INSPECTED,
  yearOfLawReports: INSPECTED,
  zverejnenoNaWebu: INSPECTED,
} as const satisfies Record<string, MetadataTextDisposition>;

export const isClassifiedMetadataKey = (
  key: string,
): key is
  | keyof typeof METADATA_TEXT_DISPOSITIONS
  | typeof META_URL_DIAGNOSTICS =>
  key === META_URL_DIAGNOSTICS ||
  Object.hasOwn(METADATA_TEXT_DISPOSITIONS, key);

type DisplayText = { field: string; value: string };

type MetadataStringLeavesOptions = {
  field: string;
  value: unknown;
  schema?: unknown;
};
const stringLeavesOf = ({
  field,
  value,
  schema,
}: MetadataStringLeavesOptions): DisplayText[] => {
  if (schema === "url") {
    return [];
  }
  if (typeof value === "string") {
    return [{ field, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      stringLeavesOf({
        field: `${field}.${index}`,
        value: item,
        schema: metadataUrlItemSchema(schema),
      }),
    );
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([property, item]) =>
    stringLeavesOf({
      field: `${field}.${property}`,
      value: item,
      schema: metadataUrlChildSchema(schema, property),
    }),
  );
};

/** Every display string a classified metadata value holds, by its path. */
export const metadataDisplayTextOf = (
  key: keyof typeof METADATA_TEXT_DISPOSITIONS | typeof META_URL_DIAGNOSTICS,
  value: unknown,
  schema?: unknown,
): DisplayText[] => {
  if (key === META_URL_DIAGNOSTICS || metadataUrlKeys(schema).has(key)) {
    return [];
  }
  const disposition: MetadataTextDisposition = METADATA_TEXT_DISPOSITIONS[key];
  return disposition.type === "excluded"
    ? []
    : stringLeavesOf({
        field: `metadata.${key}`,
        value,
        schema: metadataUrlChildSchema(schema, key),
      });
};

type MetadataTextAddressDisposition = { address: string; reason: string };

export const metadataTextAddressDispositionsForAdapter = (
  adapterKey: string,
): readonly MetadataTextAddressDisposition[] => {
  if (Object.hasOwn(AT_RIS_APPLICATIONS, adapterKey)) {
    return [
      {
        address: "metadata.relatedDecisions",
        reason:
          "RIS document Bezug is textual citation content, including URL-looking strings",
      },
      {
        address: "metadata.relatedDecisions[*]",
        reason:
          "RIS Bezug states textual citations, including URL-looking citation strings",
      },
      {
        address: "metadata.publications",
        reason:
          "RIS document Veroeffentlichungen is bibliographic text, including URL-looking references",
      },
      {
        address: "metadata.publications[*]",
        reason:
          "RIS Veroeffentlichungen mixes bibliographic text and stated URL-looking references",
      },
    ];
  }
  if (adapterKey === ADAPTER_KEYS.SK_COURTS) {
    return [
      {
        address: "metadata.statedSourceUrl",
        reason:
          "the publisher's original stated source value remains plain provenance text, including rejected links",
      },
    ];
  }
  return [];
};

/** A captured absent field is not a declared URL or an arbitrary text exemption. */
export const metadataNullOnlyAddressesForAdapter = (
  adapterKey: string,
): readonly string[] =>
  adapterKey === ADAPTER_KEYS.CZ_REGIONAL
    ? ["metadata.affectedDocs[*].url"]
    : [];

type UnclassifiedMetadataAddressesOptions = {
  schema?: unknown;
  textAddresses?: readonly MetadataTextAddressDisposition[];
  nullOnlyAddresses?: readonly string[];
};
type MetadataAddressVisit = {
  value: unknown;
  address: string;
  textAddress: string;
  node?: unknown;
};

/** The test census discovers URL-shaped names and values; production schemas alone control projection. */
export const unclassifiedMetadataAddresses = (
  metadata: Record<string, unknown>,
  {
    schema,
    textAddresses = [],
    nullOnlyAddresses = [],
  }: UnclassifiedMetadataAddressesOptions = {},
): string[] => {
  const missing: string[] = [];
  const nullOnlyPaths = new Set(nullOnlyAddresses);
  const textPaths = new Set(
    textAddresses
      .filter(({ reason }) => reason.trim().length > 0)
      .map(({ address }) => address),
  );
  const visit = ({
    value,
    address,
    textAddress,
    node,
  }: MetadataAddressVisit) => {
    if (nullOnlyPaths.has(textAddress)) {
      if (value !== null) {
        missing.push(address);
      }
      return;
    }
    if (node === "url") {
      return;
    }
    const classifiedText = textPaths.has(textAddress);
    if (typeof value === "string") {
      if (/^https?:\/\//iu.test(value.trim()) && !classifiedText) {
        missing.push(address);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        visit({
          value: item,
          address: `${address}.${index}`,
          textAddress: `${textAddress}[*]`,
          node: metadataUrlItemSchema(node),
        });
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === META_URL_DIAGNOSTICS) {
        continue;
      }
      const path = `${address}.${key}`;
      const textPath = `${textAddress}.${key}`;
      const childSchema = metadataUrlChildSchema(node, key);
      if (
        /(?:url|href|uri|link)$/iu.test(key) &&
        childSchema !== "url" &&
        !textPaths.has(textPath) &&
        !(item === null && nullOnlyPaths.has(textPath))
      ) {
        missing.push(path);
      }
      visit({
        value: item,
        address: path,
        textAddress: textPath,
        node: childSchema,
      });
    }
  };
  visit({
    value: metadata,
    address: "metadata",
    textAddress: "metadata",
    node: schema,
  });
  return [...new Set(missing)];
};
