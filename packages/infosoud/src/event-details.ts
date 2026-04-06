import {
  collectUnknownEventAttributeTypes,
  getEventAttributeLabelScopeForOrganizationType,
  getEventTypeMetadata,
  getLabeledEventAttributes,
} from "./codes.js";
import { parseInfoSoudDate, parseInfoSoudDateTime } from "./temporal.js";
import type {
  AppealDispositionDecodedEventDetail,
  AppealDispositionEventDetailSummary,
  AppealSubmissionDecodedEventDetail,
  AppealSubmissionEventDetailSummary,
  CaseEvent,
  CaseEventWithDetail,
  CaseTransferDecodedEventDetail,
  CaseTransferEventDetailSummary,
  DecodedEventDetail,
  DecisionDecodedEventDetail,
  DecisionEventDetailSummary,
  EventAttributeMap,
  EventDetailResult,
  FileTransferDecodedEventDetail,
  FileTransferEventDetailSummary,
  HearingDecodedEventDetail,
  HearingEventDetailSummary,
  LabeledEventAttribute,
  StatusDecodedEventDetail,
  StatusEventDetailSummary,
  UnknownDecodedEventDetail,
} from "./types.js";

const HEARING_EVENT_TYPES = new Set(["NAR_JED", "ZRUS_JED"]);
const DECISION_EVENT_TYPES = new Set(["VYD_ROZH"]);
const APPEAL_SUBMISSION_EVENT_TYPES = new Set(["POD_OP_PR"]);
const APPEAL_DISPOSITION_EVENT_TYPES = new Set(["VYR_OP_PR"]);
const FILE_TRANSFER_EVENT_TYPES = new Set([
  "ODES_SPIS",
  "SPIS_K_SC",
  "SPIS_K_SO",
  "SPIS_OD_SC",
  "SPIS_OD_SO",
  "VRAC_SPIS",
  "VR_SP_NS",
]);
const CASE_TRANSFER_EVENT_TYPES = new Set(["PREVD_SPIS"]);
const STATUS_EVENT_TYPES = new Set([
  "ST_VEC_OBZ",
  "ST_VEC_ODS",
  "ST_VEC_PRE",
  "ST_VEC_PUK",
  "ST_VEC_UPR",
  "ST_VEC_VYR",
]);
const MATERIAL_EVENT_TYPES = new Set([
  ...HEARING_EVENT_TYPES,
  ...DECISION_EVENT_TYPES,
  ...APPEAL_SUBMISSION_EVENT_TYPES,
  ...APPEAL_DISPOSITION_EVENT_TYPES,
  ...CASE_TRANSFER_EVENT_TYPES,
  ...STATUS_EVENT_TYPES,
  "ZAHAJ_RIZ",
]);

type EventWithMaybeDetail = CaseEvent | CaseEventWithDetail;

const parseCzechBoolean = (value: string | undefined): boolean | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLocaleLowerCase("cs-CZ");
  if (normalized === "ano") {
    return true;
  }

  if (normalized === "ne") {
    return false;
  }

  return null;
};

const firstNonEmpty = (
  ...values: (string | null | undefined)[]
): string | null => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
};

const getEventAttributeMapFromEntries = (
  attributes:
    | readonly LabeledEventAttribute[]
    | readonly { hodnota: string; typ: string }[],
): EventAttributeMap =>
  Object.fromEntries(attributes.map(({ hodnota, typ }) => [typ, hodnota]));

const parseEventDate = (value: string | null | undefined) =>
  parseInfoSoudDate(value);

const buildDecodedBase = (
  detail: EventDetailResult,
): {
  readonly attributeEntries: LabeledEventAttribute[];
  readonly attributeMap: EventAttributeMap;
  readonly metadata: ReturnType<typeof getEventTypeMetadata>;
  readonly unknownAttributeTypes: string[];
} => {
  const attributeEntries = getLabeledEventAttributes(detail);

  return {
    attributeEntries,
    attributeMap: getEventAttributeMapFromEntries(attributeEntries),
    metadata: getEventTypeMetadata(detail),
    unknownAttributeTypes: collectUnknownEventAttributeTypes(detail),
  };
};

export const getEventAttributeMap = (
  detail: EventDetailResult,
): EventAttributeMap => getEventAttributeMapFromEntries(detail.atributy);

export const getEventAttribute = (
  detail: EventDetailResult,
  attributeType: string,
): string | null => getEventAttributeMap(detail)[attributeType] ?? null;

export const getHearingEventDetailSummary = (
  detail: EventDetailResult,
): HearingEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);

  return {
    cancelled: parseCzechBoolean(attributes.JED_ZRUS),
    hearingType: attributes.JED_DRUH ?? null,
    result: attributes.JED_VYSLED ?? null,
    resultRecordedOn: attributes.JED_D_Z_V ?? null,
    resultRecordedOnDate: parseInfoSoudDate(attributes.JED_D_Z_V),
    room: attributes.JED_SIN ?? null,
    startsAt: attributes.JED_D_ZAC ?? null,
    startsAtDateTime: parseInfoSoudDateTime(attributes.JED_D_ZAC),
  };
};

export const getDecisionEventDetailSummary = (
  detail: EventDetailResult,
): DecisionEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);

  return {
    cancelled: parseCzechBoolean(attributes.ROZH_ZRUS),
    cancelledOn: parseInfoSoudDate(attributes.ROZH_D_ZRU),
    courtLevel: attributes.ROZH_DR_S ?? null,
    decisionType: attributes.ROZH_DR_RO ?? null,
    dictatedOn: parseInfoSoudDate(attributes.ROZH_D_DIK),
    dispatchedOn: parseInfoSoudDate(attributes.ROZH_D_VYP),
    disposesCase: parseCzechBoolean(attributes.ROZH_KON),
    finalOn: parseInfoSoudDate(attributes.ROZH_D_PM),
    issuedOn: parseInfoSoudDate(attributes.ROZH_D_VYD),
    result: attributes.ROZH_VYS ?? null,
  };
};

export const getAppealSubmissionEventDetailSummary = (
  detail: EventDetailResult,
): AppealSubmissionEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);
  const attributeScope = getEventAttributeLabelScopeForOrganizationType(
    detail.typOrganizace,
  );
  const submittedAtPostOnRaw = firstNonEmpty(
    attributes.OP_D_DOSO,
    attributeScope === "ks" ? undefined : attributes.OP_D_PODA,
  );
  const submittedToCourtOnRaw = firstNonEmpty(
    attributes.OP_D_DOSLO,
    attributeScope === "ks" ? attributes.OP_D_PODA : undefined,
  );
  const filedOnRaw = firstNonEmpty(submittedAtPostOnRaw, submittedToCourtOnRaw);

  return {
    againstDecisionIssuedOn: parseInfoSoudDate(attributes.OP_D_VYD),
    againstDecisionType: attributes.OP_D_ROZH ?? null,
    againstDecisionVenue: attributes.OP_ROZ_PR ?? null,
    filedOn: parseInfoSoudDate(filedOnRaw),
    forwardedToSecondLevelOn: parseInfoSoudDate(attributes.OP_D_P2),
    remedyType: attributes.OP_DRUH ?? null,
    submittedAtPostOn: parseInfoSoudDate(submittedAtPostOnRaw),
    submittedToCourtOn: parseInfoSoudDate(submittedToCourtOnRaw),
  };
};

export const getAppealDispositionEventDetailSummary = (
  detail: EventDetailResult,
): AppealDispositionEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);
  const resolvedOnRaw = firstNonEmpty(
    attributes.OP_D_VYR,
    attributes.OP_D_VYD_O,
    attributes.OP_V_2ST,
  );

  return {
    resolutionAbout: attributes.OP_ROZ_O_O ?? null,
    resolutionDecisionIssuedOn: parseInfoSoudDate(attributes.OP_D_VYD_O),
    resolutionType: attributes.OP_DR_ROZH ?? null,
    resolvedBySuperiorCourtOn: parseInfoSoudDate(attributes.OP_V_2ST),
    resolvedOn: parseInfoSoudDate(resolvedOnRaw),
    result: attributes.OP_VYSL ?? null,
  };
};

export const getFileTransferEventDetailSummary = (
  detail: EventDetailResult,
): FileTransferEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);

  return {
    expectedReturnOn: parseInfoSoudDate(attributes.OD_SP_D_OV),
    purpose: attributes.OD_SP_UCEL ?? null,
    recipient: firstNonEmpty(attributes.OD_SP_KOMU, attributes.OS_VRAC),
    returnedOn: parseInfoSoudDate(
      firstNonEmpty(
        attributes.OD_SP_D_VR,
        attributes.OS_SP_D_VR,
        attributes.VR_SP_D_VR,
      ),
    ),
    sentOn: parseInfoSoudDate(
      firstNonEmpty(
        attributes.OD_SP_D_OD,
        attributes.SPIS_KS_D,
        attributes.SPIS_OD_D,
      ),
    ),
  };
};

export const getCaseTransferEventDetailSummary = (
  detail: EventDetailResult,
): CaseTransferEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);

  return {
    destinationCaseMark: attributes.PREVD_SPZN ?? null,
    destinationCourt: attributes.PREVD_SOUD ?? null,
    relatedCase: firstNonEmpty(attributes.PO_VEC, attributes.PRED_VEC),
    transferredOn: parseInfoSoudDate(attributes.PREVD_D_OD),
  };
};

export const getStatusEventDetailSummary = (
  detail: EventDetailResult,
): StatusEventDetailSummary => {
  const attributes = getEventAttributeMap(detail);

  return {
    detail: attributes.ST_VEC_UPR ?? null,
    effectiveOn: parseInfoSoudDate(attributes.ST_VEC_D_D),
    finalityOn: parseInfoSoudDate(
      firstNonEmpty(attributes.ROZH_D_PM, attributes.ST_VEC_D_D),
    ),
    resolution: attributes.ST_VEC_ZVR ?? null,
    status: attributes.STAV_VECI ?? null,
  };
};

export const decodeEventDetail = (
  detail: EventDetailResult,
): DecodedEventDetail => {
  const base = buildDecodedBase(detail);

  if (HEARING_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: HearingDecodedEventDetail = {
      ...base,
      eventType: detail.typUdalosti,
      hearing: getHearingEventDetailSummary(detail),
      kind: "hearing",
    };
    return decoded;
  }

  if (DECISION_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: DecisionDecodedEventDetail = {
      ...base,
      decision: getDecisionEventDetailSummary(detail),
      eventType: detail.typUdalosti,
      kind: "decision",
    };
    return decoded;
  }

  if (APPEAL_SUBMISSION_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: AppealSubmissionDecodedEventDetail = {
      ...base,
      appealSubmission: getAppealSubmissionEventDetailSummary(detail),
      eventType: detail.typUdalosti,
      kind: "appeal_submission",
    };
    return decoded;
  }

  if (APPEAL_DISPOSITION_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: AppealDispositionDecodedEventDetail = {
      ...base,
      appealDisposition: getAppealDispositionEventDetailSummary(detail),
      eventType: detail.typUdalosti,
      kind: "appeal_disposition",
    };
    return decoded;
  }

  if (FILE_TRANSFER_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: FileTransferDecodedEventDetail = {
      ...base,
      eventType: detail.typUdalosti,
      fileTransfer: getFileTransferEventDetailSummary(detail),
      kind: "file_transfer",
    };
    return decoded;
  }

  if (CASE_TRANSFER_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: CaseTransferDecodedEventDetail = {
      ...base,
      caseTransfer: getCaseTransferEventDetailSummary(detail),
      eventType: detail.typUdalosti,
      kind: "case_transfer",
    };
    return decoded;
  }

  if (STATUS_EVENT_TYPES.has(detail.typUdalosti)) {
    const decoded: StatusDecodedEventDetail = {
      ...base,
      eventType: detail.typUdalosti,
      kind: "status",
      status: getStatusEventDetailSummary(detail),
    };
    return decoded;
  }

  const decoded: UnknownDecodedEventDetail = {
    ...base,
    eventType: detail.typUdalosti,
    kind: "unknown",
  };
  return decoded;
};

const getCaseEventDateUnixMs = (event: EventWithMaybeDetail): number | null => {
  if ("decodedDetail" in event && event.decodedDetail?.kind === "hearing") {
    const startsAtUnixMs = event.decodedDetail.hearing.startsAtDateTime.unixMs;
    if (startsAtUnixMs !== null) {
      return startsAtUnixMs;
    }
  }

  return parseEventDate(event.datum).unixMs;
};

export const isMaterialCaseEvent = (
  event: Pick<EventWithMaybeDetail, "udalost">,
): boolean => MATERIAL_EVENT_TYPES.has(event.udalost);

export const getNextHearingCaseEvent = (
  events: readonly EventWithMaybeDetail[],
  options: { readonly now?: Date | number | undefined } = {},
): EventWithMaybeDetail | null => {
  const nowUnixMs =
    typeof options.now === "number"
      ? options.now
      : options.now instanceof Date
        ? options.now.getTime()
        : Date.now();

  const futureHearings = events
    .filter((event) => HEARING_EVENT_TYPES.has(event.udalost))
    .filter((event) => {
      if ("decodedDetail" in event && event.decodedDetail?.kind === "hearing") {
        return !event.decodedDetail.hearing.cancelled;
      }

      return !event.zruseno;
    })
    .map((event) => ({
      event,
      unixMs: getCaseEventDateUnixMs(event),
    }))
    .filter(
      (value): value is { event: EventWithMaybeDetail; unixMs: number } =>
        value.unixMs !== null && value.unixMs >= nowUnixMs,
    )
    .toSorted((left, right) => left.unixMs - right.unixMs);

  return futureHearings.at(0)?.event ?? null;
};

export const getLatestDecisionCaseEvent = (
  events: readonly EventWithMaybeDetail[],
): EventWithMaybeDetail | null => {
  const matchingEvents = events
    .filter((event) => event.udalost === "VYD_ROZH")
    .map((event) => ({
      event,
      unixMs:
        "decodedDetail" in event && event.decodedDetail?.kind === "decision"
          ? (event.decodedDetail.decision.issuedOn.unixMs ??
            getCaseEventDateUnixMs(event))
          : getCaseEventDateUnixMs(event),
    }))
    .filter(
      (value): value is { event: EventWithMaybeDetail; unixMs: number } =>
        value.unixMs !== null,
    )
    .toSorted((left, right) => right.unixMs - left.unixMs);

  return matchingEvents.at(0)?.event ?? null;
};

export const getLatestMaterialCaseEvent = (
  events: readonly EventWithMaybeDetail[],
): EventWithMaybeDetail | null => {
  const matchingEvents = events
    .filter(isMaterialCaseEvent)
    .map((event) => ({
      event,
      unixMs: getCaseEventDateUnixMs(event),
    }))
    .filter(
      (value): value is { event: EventWithMaybeDetail; unixMs: number } =>
        value.unixMs !== null,
    )
    .toSorted((left, right) => right.unixMs - left.unixMs);

  return matchingEvents.at(0)?.event ?? null;
};

export const enrichCaseEventWithDetail = ({
  detail,
  event,
}: {
  detail: EventDetailResult | null;
  event: CaseEvent;
}): CaseEventWithDetail => {
  const decodedDetail = detail ? decodeEventDetail(detail) : null;

  return {
    ...event,
    decodedDetail,
    detail,
    detailAttributeEntries: decodedDetail?.attributeEntries ?? [],
    detailAttributes: decodedDetail?.attributeMap ?? {},
    detailTypeDescription: decodedDetail?.metadata.description ?? null,
    detailTypeKnown: decodedDetail?.metadata.known ?? null,
    detailTypeLabel: decodedDetail?.metadata.label ?? null,
    detailTypeTooltip: decodedDetail?.metadata.tooltip ?? null,
    detailUnknownAttributeTypes: decodedDetail?.unknownAttributeTypes ?? [],
    hearingDetail:
      decodedDetail?.kind === "hearing" ? decodedDetail.hearing : null,
  };
};
