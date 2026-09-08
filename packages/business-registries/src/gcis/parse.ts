import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import { trimToNull } from "../shared/strings.js";
import type {
  GcisCompany,
  GcisCompanyStatus,
  GcisRawCompany,
  GcisSearchResult,
} from "./types.js";

// GCIS does not host a stable per-entity HTML page on data.gcis.nat.gov.tw,
// so the registryUrl points back at the dataset API call that produced
// the record. The portal at `findbiz.nat.gov.tw` does host an HTML
// view, but resolution uses a session-bound key that the open-data
// surface does not return — linking there would 404 once the session
// expires.
const GCIS_LOOKUP_DATASET = "5F64D864-61CB-4D0D-8AD9-492047CC1EA6";
const GCIS_API_BASE = "https://data.gcis.nat.gov.tw/od/data/api";
const TAIWAN_TIME_ZONE = "Asia/Taipei";

// 公司狀況 codes the GCIS name-search endpoint surfaces. Lookup-only
// responses (5F64D864-…) omit the numeric code; we then fall back to
// matching the Chinese descriptor.
const STATUS_CODE_MAP: Record<string, GcisCompanyStatus> = {
  // 核准設立 — approved (active limited company).
  "01": { type: "active" },
  // 核准登記 — approved registration (typically a foreign branch).
  "02": { type: "active" },
  // 廢止 — revoked.
  "03": { type: "dissolved" },
  // 撤銷 — cancelled.
  "04": { type: "dissolved" },
  // 解散 — dissolved.
  "05": { type: "dissolved" },
  // 停業 — suspension (operational pause, registration intact).
  "06": { type: "suspended" },
  // 歇業 — discontinued (sometimes "停業" depending on the source).
  "09": { type: "suspended" },
};

// Free-text fallback. GCIS sometimes ships the descriptor without the
// numeric code; we recognise the canonical Chinese terms upstream
// returns in practice. Anything else falls through to "unknown" so we
// do not misreport state.
const STATUS_TEXT_MAP: Record<string, GcisCompanyStatus> = {
  核准設立: { type: "active" },
  核准登記: { type: "active" },
  停業: { type: "suspended" },
  歇業: { type: "suspended" },
  解散: { type: "dissolved" },
  廢止: { type: "dissolved" },
  撤銷: { type: "dissolved" },
};

const parseStatus = (
  raw: GcisRawCompany,
  now: Date = new Date(),
): GcisCompanyStatus => {
  // An in-force suspension window overrides the headline status: GCIS
  // keeps `Company_Status` at "01" / 核准設立 for entities that have
  // only paused operations, but the canonical semantic state is
  // "suspended". A future end date still means the suspension is
  // currently active.
  const susStart = raw.Sus_Beg_Date?.trim();
  const susEnd = raw.Sus_End_Date?.trim();
  const startsOn = parseRocPlainDate(susStart);
  const endsOn = parseRocPlainDate(susEnd);
  const today = getTaiwanCalendarDate(now);
  if (
    startsOn !== null &&
    Temporal.PlainDate.compare(startsOn, today) <= 0 &&
    (endsOn === null || Temporal.PlainDate.compare(today, endsOn) <= 0)
  ) {
    return { type: "suspended" };
  }
  const statusCode = raw.Company_Status?.trim();
  if (statusCode) {
    const mapped = STATUS_CODE_MAP[statusCode];
    if (mapped) {
      return mapped;
    }
  }
  const desc = raw.Company_Status_Desc?.trim();
  if (desc) {
    const mapped = STATUS_TEXT_MAP[desc];
    if (mapped) {
      return mapped;
    }
  }
  return { type: "unknown" };
};

const getTaiwanCalendarDate = (date: Date): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(TAIWAN_TIME_ZONE)
    .toPlainDate();

// ROC-era (民國) date → Gregorian ISO date.
//
// GCIS encodes dates as digit strings: the leading 2-3 digits are the
// ROC year (ROC 1 = 1912), followed by 2-digit month and day. Both
// `0760221` (ROC 76 / 1987-02-21) and `1150525` (ROC 115 / 2026-05-25)
// are valid shapes seen in production payloads.
//
// Returns null when the input is empty, malformed, or describes an
// out-of-range month/day. We do not throw — bad upstream dates should
// degrade the field, not the whole lookup.
const parseRocPlainDate = (
  input: string | undefined,
): Temporal.PlainDate | null => {
  if (!input) {
    return null;
  }
  const trimmed = input.trim();
  // Expect 6-7 digits: 2-3 year digits + 2 month + 2 day.
  const match = /^(?<year>\d{1,3})(?<month>\d{2})(?<day>\d{2})$/u.exec(trimmed);
  if (!match) {
    return null;
  }
  const { year: yearStr, month: monthStr, day: dayStr } = match.groups ?? {};
  if (!yearStr || !monthStr || !dayStr) {
    return null;
  }
  const rocYear = Number(yearStr);
  if (rocYear < 1) {
    return null;
  }
  return Result.try(() =>
    Temporal.PlainDate.from(
      {
        day: Number(dayStr),
        month: Number(monthStr),
        year: rocYear + 1911,
      },
      { overflow: "reject" },
    ),
  ).unwrapOr(null);
};

const parseRocDate = (input: string | undefined): string | null =>
  parseRocPlainDate(input)?.toString() ?? null;

const numberOrNull = (input: number | undefined): number | null =>
  typeof input === "number" && Number.isFinite(input) ? input : null;

const buildRegistryUrl = (taxId: string): string => {
  const filter = encodeURIComponent(`Business_Accounting_NO eq '${taxId}'`);
  return `${GCIS_API_BASE}/${GCIS_LOOKUP_DATASET}?$format=json&$filter=${filter}`;
};

export const parseCompany = (raw: GcisRawCompany, now?: Date): GcisCompany => {
  const taxId = raw.Business_Accounting_NO;
  return {
    taxId,
    name: trimToNull(raw.Company_Name) ?? taxId,
    capitalAmount: numberOrNull(raw.Capital_Stock_Amount),
    paidInCapitalAmount: numberOrNull(raw.Paid_In_Capital_Amount),
    responsibleName: trimToNull(raw.Responsible_Name),
    location: trimToNull(raw.Company_Location),
    registerOrganization: trimToNull(raw.Register_Organization_Desc),
    setupDateRoc: trimToNull(raw.Company_Setup_Date),
    setupDate: parseRocDate(raw.Company_Setup_Date),
    lastChangeDateRoc: trimToNull(raw.Change_Of_Approval_Data),
    lastChangeDate: parseRocDate(raw.Change_Of_Approval_Data),
    status: parseStatus(raw, now),
    statusDescription: trimToNull(raw.Company_Status_Desc),
    registryUrl: buildRegistryUrl(taxId),
  };
};

export const parseSearchEntry = (
  raw: GcisRawCompany,
  now?: Date,
): GcisSearchResult => ({
  taxId: raw.Business_Accounting_NO,
  name: trimToNull(raw.Company_Name) ?? raw.Business_Accounting_NO,
  location: trimToNull(raw.Company_Location),
  status: parseStatus(raw, now),
});
