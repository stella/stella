export type CourtType = "KS" | "MS" | "NS" | "OS" | "VS";

export type FetchLike = (
  input: URL | Request | string,
  init?: RequestInit,
) => Promise<Response>;

export type SpisZn = {
  readonly cisloSenatu: number;
  readonly druhVeci: string;
  readonly bcVec: number;
  readonly rocnik: number;
  readonly courtCode?: string | undefined;
};

export type CourtEntry = {
  readonly kod: string;
  readonly nazev: string;
};

export type CourtMap = Record<string, string>;

export type CaseMarkId = {
  readonly cisloSenatu: number;
  readonly druhVeci: string;
  readonly bcVec: number;
  readonly rocnik: number;
  readonly organizace: string;
};

export type CaseEvent = {
  readonly udalostId: number | null;
  readonly udalost: string;
  readonly poradi: number;
  readonly datum: string;
  readonly zruseno: boolean;
  readonly znackaId: CaseMarkId;
  readonly jednani: unknown[];
};

export type RelatedCase = {
  readonly cisloSenatu: number;
  readonly druhVeci: string;
  readonly bcVec: number;
  readonly rocnik: number;
  readonly organizace: string;
};

export type CaseSearchResult = {
  readonly cislo: number;
  readonly druh: string;
  readonly rocnik: number;
  readonly bcVec: number;
  readonly nadrizenaOrganizace: string | null;
  readonly organizace: string;
  readonly typOrganizace: string;
  readonly stav: string | null;
  readonly stavDatum: string | null;
  readonly napad: unknown;
  readonly udalosti: CaseEvent[];
  readonly navazneVeci: RelatedCase[];
  readonly platneK: string | null;
};

export type HearingEvent = {
  readonly cislo: number | null;
  readonly bcVec: number | null;
  readonly druh: string | null;
  readonly rocnik: number | null;
  readonly datum: string;
  readonly cas: string;
  readonly predmetJednani: string | null;
  readonly resitel: string | null;
  readonly jednaniZruseno: boolean | null;
  readonly neverejneJednani: boolean | null;
  readonly druhJednani: string | null;
  readonly vysledek: string | null;
  readonly datumZapisuVysledku: string | null;
  readonly jednaciSin: string | null;
};

export type HearingsSearchResult = {
  readonly nadrizenaOrganizace: string | null;
  readonly organizace: string;
  readonly jednaciSin: string | null;
  readonly datum: string | null;
  readonly typ: string;
  readonly cislo: number;
  readonly bcVec: number;
  readonly druh: string;
  readonly rocnik: number;
  readonly udalosti: HearingEvent[];
  readonly platneK: string | null;
};

export type EventAttribute = {
  readonly typ: string;
  readonly hodnota: string;
};

export type LabeledEventAttribute = EventAttribute & {
  readonly label: string | null;
  readonly known: boolean;
};

export type EventDetailResult = {
  readonly typUdalosti: string;
  readonly datumUdalost: string | null;
  readonly cislo: number;
  readonly druh: string;
  readonly rocnik: number;
  readonly bcVec: number;
  readonly nadrizenaOrganizace: string | null;
  readonly organizace: string;
  readonly typOrganizace: string;
  readonly stav: string | null;
  readonly stavDatum: string | null;
  readonly napad: unknown;
  readonly atributy: EventAttribute[];
  readonly navazneVeci: RelatedCase[];
  readonly platneK: string | null;
};

export type EventAttributeMap = Record<string, string>;

export type ParsedInfoSoudDate = {
  readonly isoDate: string | null;
  readonly raw: string | null;
  readonly unixMs: number | null;
};

export type ParsedInfoSoudDateTime = {
  /**
   * Prague local wall time in ISO-like form without a timezone offset.
   * Use `unixMs` when you need an absolute instant for comparisons.
   */
  readonly isoDateTime: string | null;
  readonly raw: string | null;
  readonly unixMs: number | null;
};

export type EventTypeMetadata = {
  readonly description: string | null;
  readonly known: boolean;
  readonly label: string | null;
  readonly tooltip: string | null;
};

export type HearingEventDetailSummary = {
  readonly cancelled: boolean | null;
  readonly hearingType: string | null;
  readonly result: string | null;
  readonly resultRecordedOn: string | null;
  readonly resultRecordedOnDate: ParsedInfoSoudDate;
  readonly room: string | null;
  readonly startsAt: string | null;
  readonly startsAtDateTime: ParsedInfoSoudDateTime;
};

export type DecisionEventDetailSummary = {
  readonly cancelled: boolean | null;
  readonly cancelledOn: ParsedInfoSoudDate;
  readonly courtLevel: string | null;
  readonly decisionType: string | null;
  readonly dictatedOn: ParsedInfoSoudDate;
  readonly dispatchedOn: ParsedInfoSoudDate;
  readonly disposesCase: boolean | null;
  readonly finalOn: ParsedInfoSoudDate;
  readonly issuedOn: ParsedInfoSoudDate;
  readonly result: string | null;
};

export type AppealSubmissionEventDetailSummary = {
  readonly againstDecisionIssuedOn: ParsedInfoSoudDate;
  readonly againstDecisionType: string | null;
  readonly againstDecisionVenue: string | null;
  readonly filedOn: ParsedInfoSoudDate;
  readonly forwardedToSecondLevelOn: ParsedInfoSoudDate;
  readonly remedyType: string | null;
  readonly submittedAtPostOn: ParsedInfoSoudDate;
  readonly submittedToCourtOn: ParsedInfoSoudDate;
};

export type AppealDispositionEventDetailSummary = {
  readonly resolutionAbout: string | null;
  readonly resolutionDecisionIssuedOn: ParsedInfoSoudDate;
  readonly resolutionType: string | null;
  readonly resolvedBySuperiorCourtOn: ParsedInfoSoudDate;
  readonly resolvedOn: ParsedInfoSoudDate;
  readonly result: string | null;
};

export type FileTransferEventDetailSummary = {
  readonly expectedReturnOn: ParsedInfoSoudDate;
  readonly purpose: string | null;
  readonly recipient: string | null;
  readonly returnedOn: ParsedInfoSoudDate;
  readonly sentOn: ParsedInfoSoudDate;
};

export type CaseTransferEventDetailSummary = {
  readonly destinationCaseMark: string | null;
  readonly destinationCourt: string | null;
  readonly relatedCase: string | null;
  readonly transferredOn: ParsedInfoSoudDate;
};

export type StatusEventDetailSummary = {
  readonly detail: string | null;
  readonly effectiveOn: ParsedInfoSoudDate;
  readonly finalityOn: ParsedInfoSoudDate;
  readonly resolution: string | null;
  readonly status: string | null;
};

export type DecodedEventDetailBase = {
  readonly attributeEntries: LabeledEventAttribute[];
  readonly attributeMap: EventAttributeMap;
  readonly eventType: string;
  readonly metadata: EventTypeMetadata;
  readonly unknownAttributeTypes: string[];
};

export type HearingDecodedEventDetail = DecodedEventDetailBase & {
  readonly hearing: HearingEventDetailSummary;
  readonly kind: "hearing";
};

export type DecisionDecodedEventDetail = DecodedEventDetailBase & {
  readonly decision: DecisionEventDetailSummary;
  readonly kind: "decision";
};

export type AppealSubmissionDecodedEventDetail = DecodedEventDetailBase & {
  readonly appealSubmission: AppealSubmissionEventDetailSummary;
  readonly kind: "appeal_submission";
};

export type AppealDispositionDecodedEventDetail = DecodedEventDetailBase & {
  readonly appealDisposition: AppealDispositionEventDetailSummary;
  readonly kind: "appeal_disposition";
};

export type FileTransferDecodedEventDetail = DecodedEventDetailBase & {
  readonly fileTransfer: FileTransferEventDetailSummary;
  readonly kind: "file_transfer";
};

export type CaseTransferDecodedEventDetail = DecodedEventDetailBase & {
  readonly caseTransfer: CaseTransferEventDetailSummary;
  readonly kind: "case_transfer";
};

export type StatusDecodedEventDetail = DecodedEventDetailBase & {
  readonly kind: "status";
  readonly status: StatusEventDetailSummary;
};

export type UnknownDecodedEventDetail = DecodedEventDetailBase & {
  readonly kind: "unknown";
};

export type DecodedEventDetail =
  | AppealDispositionDecodedEventDetail
  | AppealSubmissionDecodedEventDetail
  | CaseTransferDecodedEventDetail
  | DecisionDecodedEventDetail
  | FileTransferDecodedEventDetail
  | HearingDecodedEventDetail
  | StatusDecodedEventDetail
  | UnknownDecodedEventDetail;

export type UnknownInfoSoudCodes = {
  readonly attributeTypes: string[];
  readonly eventTypes: string[];
};

export type CaseEventWithDetail = CaseEvent & {
  readonly decodedDetail: DecodedEventDetail | null;
  readonly detail: EventDetailResult | null;
  readonly detailAttributeEntries: LabeledEventAttribute[];
  readonly detailAttributes: EventAttributeMap;
  readonly detailTypeDescription: string | null;
  readonly detailTypeKnown: boolean | null;
  readonly detailTypeLabel: string | null;
  readonly detailTypeTooltip: string | null;
  readonly detailUnknownAttributeTypes: string[];
  readonly hearingDetail: HearingEventDetailSummary | null;
};

export type CaseSearchResultWithDetails = Omit<CaseSearchResult, "udalosti"> & {
  readonly udalosti: CaseEventWithDetail[];
};

export type CaseSearchResultWithHearings = {
  readonly case: CaseSearchResult;
  readonly hearings: HearingsSearchResult;
};

export type InfoSoudCacheOptions = {
  readonly caseTtlMs?: number | undefined;
  readonly courtsTtlMs?: number | undefined;
  readonly derivedCourtMapTtlMs?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly eventDetailTtlMs?: number | undefined;
  readonly hearingsTtlMs?: number | undefined;
};

export type InfoSoudClientOptions = {
  readonly baseUrl?: string | undefined;
  readonly cache?: false | InfoSoudCacheOptions | undefined;
  readonly delayMs?: number | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
  readonly userAgent?: string | undefined;
};

export type CourtLookupOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type SearchCaseInput = {
  readonly spisZn: SpisZn | string;
  readonly courtCode?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type SearchHearingsInput = {
  readonly spisZn: SpisZn | string;
  readonly courtCode?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type SearchCaseWithHearingsInput = SearchCaseInput;

export type EventDetailInput = {
  readonly spisZn: SpisZn | string;
  readonly courtCode?: string | undefined;
  readonly eventOrder: number;
  readonly eventType: string;
  readonly signal?: AbortSignal | undefined;
};

export type CaseEventLookupInput = {
  readonly courtCode?: string | undefined;
  readonly event: Pick<CaseEvent, "poradi" | "udalost">;
  readonly signal?: AbortSignal | undefined;
  readonly spisZn: SpisZn | string;
};

export type SearchCaseWithDetailsInput = SearchCaseInput & {
  readonly includeEventTypes?: readonly string[] | undefined;
};

export type DistrictCourtsInput = {
  readonly parentCode?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};
