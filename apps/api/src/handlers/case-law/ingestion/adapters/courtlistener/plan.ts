/**
 * What a CourtListener cluster becomes, before its text is read: identity,
 * court, references, dates, judges, metadata and the stored raw. Pure: no
 * network, no database, no lookup beyond the generated court directory.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import type { DecisionJudgeInput } from "@stll/api-contract/case-law-judges";
import {
  resolveWritableUsCourt,
  type UsWritableCourtResolution,
} from "@stll/api-contract/us-courts";
import {
  canonicalUsReporterCitation,
  parseUsReporterReference,
  US_REPORTER_JURISDICTION,
} from "@stll/api-contract/us-reporter-citation";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifier,
  type DecisionIdentifiers,
  decisionIdentifierSchema,
  type DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";

import { normalizeDecisionIdentifierIn } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { canonicalDecisionDate } from "@/api/lib/dates";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/lib/legal-search/ingestion-types";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import { courtListenerRawHash, encodeCourtListenerRaw } from "./raw";
import {
  type AdmittedCitation,
  type AdmittedCourtListenerRecord,
  type AdmittedOpinion,
  admitCourtListenerRecord,
} from "./record";
import {
  COURTLISTENER_REJECTION_REASON,
  type CourtListenerRecordRejectedError,
  type CourtListenerRejectionReason,
  rejectCourtListenerRecord,
  type RejectionDiagnostic,
} from "./rejection";
import {
  compareBytewise,
  compareCanonicalIds,
  hasVisibleText,
  type PersonRow,
} from "./snapshot-columns";
import { CITATION_TYPES, OPINION_TYPES } from "./vocabulary";

const COUNTRY = US_REPORTER_JURISDICTION;
const LANGUAGE = "en";
const US_REPORTS_EDITION = "U.S.";
const CASE_PAGE_ORIGIN = "https://www.courtlistener.com";

/** A condition the plan records without rejecting the cluster. */
type PlanDiagnostic = { readonly code: string; readonly path: string };

type PlanRejection = {
  readonly reason: CourtListenerRejectionReason;
  readonly diagnostics: readonly RejectionDiagnostic[];
};

// ── Court ───────────────────────────────────────────────

const courtRejection = (
  reason: Extract<UsWritableCourtResolution, { type: "rejected" }>["reason"],
): CourtListenerRejectionReason => {
  switch (reason) {
    case "unknown":
      return COURTLISTENER_REJECTION_REASON.COURT_UNKNOWN;
    case "not-writable":
      return COURTLISTENER_REJECTION_REASON.COURT_NOT_WRITABLE;
    case "testing":
    case "outside-jurisdiction":
      return COURTLISTENER_REJECTION_REASON.COURT_REJECTED;
    default: {
      reason satisfies never;
      return panic(`Unhandled court rejection: ${String(reason)}`);
    }
  }
};

// ── References ──────────────────────────────────────────

type CitationReference = {
  readonly citationId: string;
  readonly identifier: DecisionIdentifier;
  /** The canonical edition where the reporter table settles it, else as printed. */
  readonly reporter: string;
  readonly volume: string;
  readonly page: string;
  readonly canonical: boolean;
};

const citationReference = ({
  row,
  type,
}: AdmittedCitation): CitationReference | null => {
  const volume = row.volume.trim();
  const reporter = row.reporter.trim();
  const page = row.page.trim();
  if (volume === "" || reporter === "" || page === "") {
    return null;
  }
  const printed = `${volume} ${reporter} ${page}`;
  const identifierType = CITATION_TYPES[type];
  const canonical =
    identifierType === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION
      ? canonicalUsReporterCitation(printed)
      : null;
  const parsed =
    canonical === null ? null : parseUsReporterReference(canonical);
  const edition = parsed?.type === "full" ? parsed.candidates[0] : null;
  return {
    citationId: row.id,
    identifier: { type: identifierType, value: canonical ?? printed },
    reporter: edition?.edition ?? reporter,
    volume: edition?.volume ?? volume,
    page: edition?.page ?? page,
    canonical: edition !== null,
  };
};

/** Fixed order: reporter spelling, volume, page, then numeric citation ID. */
const compareReferences = (
  left: CitationReference,
  right: CitationReference,
): number =>
  compareBytewise(left.reporter, right.reporter) ||
  compareBytewise(left.volume, right.volume) ||
  compareBytewise(left.page, right.page) ||
  compareCanonicalIds(left.citationId, right.citationId);

type ReferencePlan = {
  readonly caseNumber: string;
  readonly caseNumberType: DecisionPrimaryReferenceType;
  readonly identifiers: DecisionIdentifiers;
};

/**
 * The primary reference and every identifier the publisher states. A U.S.
 * Reports tuple wins, then another complete reporter tuple, then the docket;
 * a neutral citation is listed but never primary.
 */
const planReferences = (
  admitted: AdmittedCourtListenerRecord,
  diagnostics: PlanDiagnostic[],
): Result<ReferencePlan, PlanRejection> => {
  const references: CitationReference[] = [];
  for (const [index, citation] of admitted.citations.entries()) {
    const reference = citationReference(citation);
    const path = `citations.${index}`;
    if (reference === null) {
      diagnostics.push({ code: "incomplete-citation-tuple", path });
      continue;
    }
    const { type } = reference.identifier;
    if (
      type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION &&
      !reference.canonical
    ) {
      diagnostics.push({ code: "reporter-grammar-unresolved", path });
    }
    references.push(reference);
  }
  const ofType = (type: DecisionIdentifier["type"]) =>
    references
      .filter(({ identifier }) => identifier.type === type)
      .toSorted(compareReferences);
  const reporters = ofType(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION);
  const neutrals = ofType(DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION);
  const docketNumber = admitted.record.docket.docket_number.trim();
  const docket: DecisionIdentifier[] = hasVisibleText(docketNumber)
    ? [{ type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: docketNumber }]
    : [];

  const usReports = reporters.filter(
    ({ canonical, reporter }) => canonical && reporter === US_REPORTS_EDITION,
  );
  const primary =
    [...usReports, ...reporters].at(0)?.identifier ?? docket.at(0);
  if (primary === undefined) {
    return Result.err({
      reason: COURTLISTENER_REJECTION_REASON.MISSING_PRIMARY_REFERENCE,
      diagnostics: [
        { path: "citations", detail: "no reporter tuple or docket" },
      ],
    });
  }

  const candidates = [
    primary,
    ...[...reporters, ...neutrals].map(({ identifier }) => identifier),
    ...docket,
  ];
  const invalid = candidates.flatMap((identifier, index) =>
    v.is(decisionIdentifierSchema, identifier) &&
    normalizeDecisionIdentifierIn(COUNTRY, identifier) !== ""
      ? []
      : [
          {
            path: `identifiers.${index}`,
            detail: `unstorable ${identifier.type}`,
          },
        ],
  );
  if (invalid.length > 0) {
    return Result.err({
      reason: COURTLISTENER_REJECTION_REASON.INVALID_IDENTIFIER,
      diagnostics: invalid,
    });
  }

  const seen = new Set<string>();
  const distinct = candidates.filter((identifier) => {
    const key = `${identifier.type}:${normalizeDecisionIdentifierIn(COUNTRY, identifier)}`;
    const repeated = seen.has(key);
    seen.add(key);
    return !repeated;
  });
  if (distinct.length > DECISION_IDENTIFIER_MAX_COUNT) {
    return Result.err({
      reason: COURTLISTENER_REJECTION_REASON.IDENTIFIER_OVERFLOW,
      diagnostics: [
        {
          path: "identifiers",
          detail: `${distinct.length} exceed the limit of ${DECISION_IDENTIFIER_MAX_COUNT}`,
        },
      ],
    });
  }
  return Result.ok({
    caseNumber: primary.value,
    caseNumberType:
      primary.type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION
        ? primary.type
        : DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    identifiers: [primary, ...distinct.slice(1)],
  });
};

// ── Judges ──────────────────────────────────────────────

/** The generational suffixes the people table codes, as printed. */
const PERSON_SUFFIXES: ReadonlyMap<string, string> = new Map([
  ["", ""],
  ["jr", "Jr."],
  ["sr", "Sr."],
  ["1", "I"],
  ["2", "II"],
  ["3", "III"],
  ["4", "IV"],
]);

const PER_CURIAM = /^per\s+curiam\.?$/iu;

const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** A supplied person's name, or `null` where the row cannot state one. */
const personName = (person: PersonRow | undefined): string | null => {
  const suffix = PERSON_SUFFIXES.get(person?.name_suffix ?? "");
  if (
    person === undefined ||
    suffix === undefined ||
    !hasVisibleText(person.name_last)
  ) {
    return null;
  }
  return collapse(
    [person.name_first, person.name_middle, person.name_last, suffix].join(" "),
  );
};

type UnresolvedAttribution = {
  readonly opinionId: string;
  readonly kind: "author-id" | "joiner-id" | "joined-by-text";
  readonly value: string;
};

/**
 * Judges by opinion, in opinion order. Absent, never empty, where nothing is
 * attributed: an empty list would clear judges a decision already has.
 */
const planJudges = (
  { judgeRelations: relations }: AdmittedCourtListenerRecord,
  ordered: readonly AdmittedOpinion[],
) => {
  const judges = new Map<string, DecisionJudgeInput>();
  const unresolved: UnresolvedAttribution[] = [];
  const add = (nameAsPrinted: string, role: DecisionJudgeInput["role"]) =>
    judges.set(`${role}\u0000${nameAsPrinted}`, { role, nameAsPrinted });
  const attribute = (
    personId: string,
    role: DecisionJudgeInput["role"],
    missing: UnresolvedAttribution,
  ) => {
    const name = personName(relations?.people.get(personId));
    if (name === null) {
      unresolved.push(missing);
    } else {
      add(name, role);
    }
  };

  for (const { perCuriam, row, type } of ordered) {
    const role = OPINION_TYPES[type].judgeRole;
    const printed = collapse(row.author_str);
    // A per curiam opinion is the court's own and names no judge.
    if (!perCuriam && printed !== "" && !PER_CURIAM.test(printed)) {
      add(printed, role);
    } else if (!perCuriam && row.author_id !== "") {
      attribute(row.author_id, role, {
        opinionId: row.id,
        kind: "author-id",
        value: row.author_id,
      });
    }
    const joiners = (relations?.joinedBy ?? [])
      .filter(({ opinionId }) => opinionId === row.id)
      .toSorted((left, right) =>
        compareCanonicalIds(left.personId, right.personId),
      );
    for (const { personId } of joiners) {
      attribute(personId, role, {
        opinionId: row.id,
        kind: "joiner-id",
        value: personId,
      });
    }
    if (joiners.length === 0 && hasVisibleText(row.joined_by_str)) {
      unresolved.push({
        opinionId: row.id,
        kind: "joined-by-text",
        value: row.joined_by_str,
      });
    }
  }
  return {
    judges: judges.size > 0 ? [...judges.values()] : undefined,
    unresolved,
  };
};

// ── Metadata ────────────────────────────────────────────

/** The values the publisher stated; a blank column is absence, not a value. */
const stated = (
  values: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => hasVisibleText(value)),
  );

const planMetadata = (
  admitted: AdmittedCourtListenerRecord,
  ordered: readonly AdmittedOpinion[],
  unresolved: readonly UnresolvedAttribution[],
): Record<string, unknown> => {
  const { cluster, court, docket, provenance } = admitted.record;
  const scdb = stated({
    id: cluster.scdb_id,
    decisionDirection: cluster.scdb_decision_direction,
    votesMajority: cluster.scdb_votes_majority,
    votesMinority: cluster.scdb_votes_minority,
  });
  return {
    courtListener: {
      snapshot: provenance.snapshot,
      clusterId: cluster.id,
      docketId: docket.id,
      opinionIds: ordered.map(({ row }) => row.id),
    },
    ...stated({
      caseName: cluster.case_name,
      caseNameShort: cluster.case_name_short,
      caseNameFull: cluster.case_name_full,
      precedentialStatus: cluster.precedential_status,
      publisherSource: cluster.source,
      disposition: cluster.disposition,
      proceduralHistory: cluster.procedural_history,
      history: cluster.history,
      posture: cluster.posture,
      natureOfSuit: cluster.nature_of_suit,
      attorneys: cluster.attorneys,
      crossReference: cluster.cross_reference,
      correction: cluster.correction,
      otherDates: cluster.other_dates,
      benchAsPrinted: cluster.judges,
      appealFrom: docket.appeal_from_str,
      docketNumberCore: docket.docket_number_core,
      docketNumberRaw: docket.docket_number_raw,
    }),
    dateFiled: {
      value: cluster.date_filed,
      approximate: admitted.dateFiledIsApproximate,
    },
    docketDates: stated({
      argued: docket.date_argued,
      reargued: docket.date_reargued,
      reargumentDenied: docket.date_reargument_denied,
      certGranted: docket.date_cert_granted,
      certDenied: docket.date_cert_denied,
      filed: docket.date_filed,
      terminated: docket.date_terminated,
    }),
    ...(Object.keys(scdb).length > 0 ? { scdb } : {}),
    publisherCourt: stated({
      id: court.id,
      shortName: court.short_name,
      fullName: court.full_name,
      citationString: court.citation_string,
    }),
    publisherBlocked: {
      blocked: admitted.blocked,
      dateBlocked: cluster.date_blocked,
    },
    opinionAttribution: ordered.map(
      ({ extractedByOcr, perCuriam, row, type }) => ({
        opinionId: row.id,
        type,
        perCuriam,
        extractedByOcr,
        ...stated({
          authorStr: row.author_str,
          authorId: row.author_id,
          joinedByStr: row.joined_by_str,
        }),
      }),
    ),
    judgeAttribution: {
      relations: admitted.judgeRelations === null ? "unavailable" : "complete",
      unresolvedCount: unresolved.length,
      unresolved,
    },
    ocr: {
      any: ordered.some(({ extractedByOcr }) => extractedByOcr),
      opinionIds: ordered.flatMap(({ extractedByOcr, row }) =>
        extractedByOcr ? [row.id] : [],
      ),
    },
  };
};

// ── The plan ────────────────────────────────────────────

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type TextFieldSource =
  | { readonly type: "present"; readonly field: string }
  | { readonly type: "absent"; readonly reason: "not_published" };

const textFieldSource = (field: string, value: string): TextFieldSource =>
  hasVisibleText(value)
    ? { type: "present", field }
    : { type: "absent", reason: "not_published" };

const decisionPlan = (
  admitted: AdmittedCourtListenerRecord,
  court: { readonly id: string; readonly canonicalName: string },
  references: ReferencePlan,
  diagnostics: PlanDiagnostic[],
) => {
  const { cluster } = admitted.record;
  // Rows in the documented order: type prefix, then numeric ID. Input order
  // and timestamps carry no meaning.
  const ordered = admitted.opinions.toSorted(
    (left, right) =>
      OPINION_TYPES[left.type].rank - OPINION_TYPES[right.type].rank ||
      compareCanonicalIds(left.row.id, right.row.id),
  );

  const decisionDate = canonicalDecisionDate(cluster.date_filed, COUNTRY);
  if (decisionDate === null) {
    diagnostics.push({
      code: hasVisibleText(cluster.date_filed)
        ? "date-filed-out-of-policy"
        : "date-filed-absent",
      path: "cluster.date_filed",
    });
  } else if (admitted.dateFiledIsApproximate) {
    diagnostics.push({
      code: "date-filed-approximate",
      path: "cluster.date_filed",
    });
  }
  const slug = SLUG.test(cluster.slug) ? `${cluster.slug}/` : "";

  const download = ordered.at(0)?.row.download_url ?? "";
  const documentUrl = sanitizeUrl(download);
  if (documentUrl === undefined && hasVisibleText(download)) {
    diagnostics.push({
      code: "download-url-unusable",
      path: "opinions.download_url",
    });
  }

  const { judges, unresolved } = planJudges(admitted, ordered);
  return {
    sourceDocumentId: admitted.clusterId,
    country: COUNTRY,
    language: LANGUAGE,
    courtId: court.id,
    court: court.canonicalName,
    ...references,
    decisionDate: decisionDate ?? undefined,
    sourceUrl: `${CASE_PAGE_ORIGIN}/opinion/${admitted.clusterId}/${slug}`,
    documentUrl,
    judges,
    textFieldSources: {
      headnote: textFieldSource("cluster.headnotes", cluster.headnotes),
      abstract: textFieldSource("cluster.syllabus", cluster.syllabus),
      summary: textFieldSource("cluster.summary", cluster.summary),
      legalSentence: { type: "absent", reason: "not_published" },
    } satisfies Record<string, TextFieldSource>,
    opinions: ordered.map(({ row, type }) => ({
      opinionId: row.id,
      scopeId: `cl-opinion:${row.id}`,
      type,
    })),
    scdbPresent: hasVisibleText(cluster.scdb_id),
    metadata: planMetadata(admitted, ordered, unresolved),
    rawHash: courtListenerRawHash(admitted.record),
    sourceRaw: encodeCourtListenerRaw(admitted.record),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    diagnostics,
  };
};

const planDecision = (
  admitted: AdmittedCourtListenerRecord,
): Result<ReturnType<typeof decisionPlan>, PlanRejection> => {
  const resolution = resolveWritableUsCourt(admitted.record.docket.court_id);
  if (resolution.type === "rejected") {
    return Result.err({
      reason: courtRejection(resolution.reason),
      diagnostics: [
        {
          path: "docket.court_id",
          detail: `court directory: ${resolution.reason}`,
        },
      ],
    });
  }
  const diagnostics: PlanDiagnostic[] = [];
  const references = planReferences(admitted, diagnostics);
  if (Result.isError(references)) {
    return Result.err(references.error);
  }
  return Result.ok(
    decisionPlan(admitted, resolution.court, references.value, diagnostics),
  );
};

export type CourtListenerDecisionPlan = ReturnType<typeof decisionPlan>;

/**
 * Admit a record and plan its decision, or reject the whole cluster. Text
 * and structure are left to the format parsers; everything here is decided
 * from the rows alone.
 */
export const planCourtListenerRecord = (
  input: unknown,
): Result<CourtListenerDecisionPlan, CourtListenerRecordRejectedError> => {
  const admitted = admitCourtListenerRecord(input);
  if (Result.isError(admitted)) {
    return Result.err(admitted.error);
  }
  const { clusterId, opinions, sourceRecordKey } = admitted.value;
  const planned = planDecision(admitted.value);
  if (Result.isError(planned)) {
    return Result.err(
      rejectCourtListenerRecord({
        ...planned.error,
        sourceRecordKey,
        clusterId,
        opinionIds: opinions.map(({ row }) => row.id),
      }),
    );
  }
  return Result.ok(planned.value);
};
