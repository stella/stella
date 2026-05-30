import { Result } from "better-result";

import { getEventLabel, resolveCourtCodeAlias } from "@stll/infosoud";
import type {
  CaseEvent,
  CaseSearchResult,
  CaseSearchResultWithHearings,
  HearingEvent,
  RelatedCase,
} from "@stll/infosoud";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

import {
  createInfoSoudClient,
  infosoudLookupBodySchema,
  toInfoSoudLookupError,
} from "./infosoud-common";

type CaseMark = {
  bcVec: number;
  cisloSenatu: number;
  druhVeci: string;
  organizace: string;
  rocnik: number;
};

type InfoSoudDisplayValue = string | number | boolean | Date | null | undefined;

export type InfoSoudLookupResult = {
  caseMark: string;
  court: string;
  courtCode: string;
  eventCount: number;
  events: {
    cancelled: boolean;
    caseMark: string;
    courtCode: string;
    date: string | null;
    isRelatedCase: boolean;
    label: string;
    order: number;
    type: string;
  }[];
  eventsTruncated: boolean;
  hearings: {
    cancelled: boolean | null;
    date: string | null;
    hearingType: string | null;
    judge: string | null;
    private: boolean | null;
    result: string | null;
    room: string | null;
    scheduledAt: string | null;
    time: string | null;
  }[];
  hearingsTruncated: boolean;
  parentCourt: string | null;
  relatedCases: {
    caseMark: string;
    courtCode: string;
  }[];
  relatedCasesTruncated: boolean;
  status: string | null;
  statusDate: string | null;
  validTo: string | null;
};

const toInfoSoudDisplayValue = (value: InfoSoudDisplayValue): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value);
};

const joinInfoSoudDisplayValues = (
  values: InfoSoudDisplayValue[],
): string | null => {
  const text = values
    .map(toInfoSoudDisplayValue)
    .filter((value) => value !== null)
    .join(" ");

  return text || null;
};

const formatCaseMark = ({
  bcVec,
  cisloSenatu,
  druhVeci,
  organizace,
  rocnik,
}: CaseMark): string =>
  `${cisloSenatu} ${druhVeci} ${bcVec}/${rocnik}${organizace ? ` ${organizace}` : ""}`;

const isSameCaseMark = (
  result: CaseSearchResult,
  event: Pick<CaseEvent, "znackaId">,
  primaryCourtCode: string | null,
): boolean =>
  event.znackaId.cisloSenatu === result.cislo &&
  event.znackaId.druhVeci === result.druh &&
  event.znackaId.bcVec === result.bcVec &&
  event.znackaId.rocnik === result.rocnik &&
  (primaryCourtCode === null || event.znackaId.organizace === primaryCourtCode);

const inferPrimaryCourtCode = (result: CaseSearchResult): string | null =>
  result.udalosti
    .find(
      (event) =>
        event.znackaId.cisloSenatu === result.cislo &&
        event.znackaId.druhVeci === result.druh &&
        event.znackaId.bcVec === result.bcVec &&
        event.znackaId.rocnik === result.rocnik &&
        event.znackaId.organizace.trim().length > 0,
    )
    ?.znackaId.organizace.trim() ?? null;

const mapCaseEvent = (
  result: CaseSearchResult,
  event: CaseEvent,
  primaryCourtCode: string | null,
): InfoSoudLookupResult["events"][number] => ({
  cancelled: event.zruseno,
  caseMark: formatCaseMark(event.znackaId),
  courtCode: event.znackaId.organizace,
  date: toInfoSoudDisplayValue(event.datum),
  isRelatedCase: !isSameCaseMark(result, event, primaryCourtCode),
  label: getEventLabel(event.udalost) ?? event.udalost,
  order: event.poradi,
  type: event.udalost,
});

const mapRelatedCase = (
  relatedCase: RelatedCase,
): InfoSoudLookupResult["relatedCases"][number] => ({
  caseMark: formatCaseMark(relatedCase),
  courtCode: relatedCase.organizace,
});

const mapHearing = (
  hearing: HearingEvent,
): InfoSoudLookupResult["hearings"][number] => ({
  cancelled: hearing.jednaniZruseno,
  date: toInfoSoudDisplayValue(hearing.datum),
  hearingType: hearing.druhJednani,
  private: hearing.neverejneJednani,
  result: hearing.vysledek,
  room: hearing.jednaciSin,
  scheduledAt: joinInfoSoudDisplayValues([hearing.datum, hearing.cas]),
  time: toInfoSoudDisplayValue(hearing.cas),
  judge: hearing.resitel,
});

type MapInfoSoudResultInput = {
  lookupResult: CaseSearchResultWithHearings;
  selectedCourtCode: string;
};

export const mapInfoSoudResult = ({
  lookupResult,
  selectedCourtCode,
}: MapInfoSoudResultInput): InfoSoudLookupResult => {
  const caseResult = lookupResult.case;
  const hearingsResult = lookupResult.hearings;
  const primaryCourtCode = inferPrimaryCourtCode(caseResult);

  return {
    caseMark: `${caseResult.cislo} ${caseResult.druh} ${caseResult.bcVec}/${caseResult.rocnik}`,
    court: caseResult.organizace,
    courtCode: primaryCourtCode ?? resolveCourtCodeAlias(selectedCourtCode),
    eventCount: caseResult.udalosti.length,
    events: caseResult.udalosti
      .slice(0, LIMITS.infoSoudEventsMax)
      .map((event) => mapCaseEvent(caseResult, event, primaryCourtCode)),
    eventsTruncated: caseResult.udalosti.length > LIMITS.infoSoudEventsMax,
    hearings: hearingsResult.udalosti
      .slice(0, LIMITS.infoSoudHearingsMax)
      .map(mapHearing),
    hearingsTruncated:
      hearingsResult.udalosti.length > LIMITS.infoSoudHearingsMax,
    parentCourt: caseResult.nadrizenaOrganizace,
    relatedCases: caseResult.navazneVeci
      .slice(0, LIMITS.infoSoudRelatedCasesMax)
      .map(mapRelatedCase),
    relatedCasesTruncated:
      caseResult.navazneVeci.length > LIMITS.infoSoudRelatedCasesMax,
    status: caseResult.stav,
    statusDate: toInfoSoudDisplayValue(caseResult.stavDatum),
    validTo: toInfoSoudDisplayValue(caseResult.platneK),
  };
};

const config = {
  body: infosoudLookupBodySchema,
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const infosoudLookup = createSafeHandler(
  config,
  async function* ({ body, request }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const client = createInfoSoudClient();
          const lookupResult = await client.searchCaseWithHearings({
            courtCode: body.courtCode,
            signal: request.signal,
            spisZn: body.spisZn,
          });

          return mapInfoSoudResult({
            lookupResult,
            selectedCourtCode: body.courtCode,
          });
        },
        catch: toInfoSoudLookupError,
      }),
    );

    return Result.ok(result);
  },
);

export default infosoudLookup;
