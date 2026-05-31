// ---------------------------------------------------------------------------
// Raw GCIS (台灣經濟部商業司) Open Data API response shapes.
//
// Two datasets back this adapter:
//
//   * 5F64D864-61CB-4D0D-8AD9-492047CC1EA6 — single-entity lookup by
//     統一編號 (tongbian, the 8-digit Business Administration Number).
//     Carries the registered seat, capital, responsible person, and
//     suspension dates.
//   * 6BBA2268-1367-4B42-9CCA-BC17499EBE8C — name search. Returns the
//     same core fields as the lookup dataset plus an explicit
//     `Company_Status` code, which the lookup dataset omits.
//
// Public endpoint: https://data.gcis.nat.gov.tw/od/data/api/<datasetId>
// Spec / portal: https://data.gcis.nat.gov.tw/main/index
// Licence: 政府資料開放授權條款 v1.0 (Open Government Data Licence).
//
// Field names are mixed CamelCase + Snake_Case in the upstream payload
// (e.g. `Company_Name`, `Business_Accounting_NO`). Locale text comes
// back in Traditional Chinese — surfaced verbatim in the domain types
// rather than transliterated.
// ---------------------------------------------------------------------------

export type GcisRawCompany = {
  // 統一編號 — the 8-digit canonical ID (Business Accounting Number).
  Business_Accounting_NO: string;
  // 公司名稱 — Traditional Chinese registered name.
  Company_Name?: string;
  // 公司狀況 — numeric status code. Documented values include
  // "01" (核准設立 / approved), "02" (核准設立 / approved branch),
  // "03" (廢止 / revoked), "04" (撤銷 / cancelled),
  // "05" (解散 / dissolved), "06" (停業 / suspended),
  // "09" (停業 / discontinued). The lookup dataset omits the code
  // and only ships `Company_Status_Desc`; the name-search dataset
  // ships both. Treat anything outside the documented set as
  // "unknown" rather than guessing.
  Company_Status?: string;
  // 公司狀況描述 — human-readable status (Traditional Chinese).
  Company_Status_Desc?: string;
  // 資本總額 / 實收資本額 — issued vs. paid-in capital in TWD.
  Capital_Stock_Amount?: number;
  Paid_In_Capital_Amount?: number;
  // 負責人 — name of the registered responsible person (single string).
  Responsible_Name?: string;
  // 登記機關 — registering authority code + description.
  Register_Organization?: string;
  Register_Organization_Desc?: string;
  // 公司所在地 — registered seat. A single free-form Chinese string;
  // GCIS does not expose structured address atoms.
  Company_Location?: string;
  // ROC-era dates encoded as `YYYMMDD` (民國年). Year segment is
  // typically 3 digits (e.g. "1150525" = ROC 115 / 2026-05-25);
  // very early registrations may be 2-digit (e.g. "0760221"
  // = ROC 76 / 1987-02-21 — TSMC's founding date).
  Company_Setup_Date?: string;
  Change_Of_Approval_Data?: string;
  Revoke_App_Date?: string;
  // Suspension lifecycle: `Sus_App_Date` = application,
  // `Sus_Beg_Date` = start, `Sus_End_Date` = end.
  Sus_App_Date?: string;
  Sus_Beg_Date?: string;
  Sus_End_Date?: string;
  // Pending case status (廢止 / 撤銷 / 解散 in-flight). Optional.
  Case_Status?: string;
  Case_Status_Desc?: string;
};

// GCIS endpoints return the raw entity array directly — there is no
// envelope, no pagination metadata, no totalElements. An empty array
// is the only "not found" signal.
export type GcisResponse = GcisRawCompany[];

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

// Status discriminated union mapped from GCIS's `Company_Status` code
// (preferred) or `Company_Status_Desc` text (fallback for the lookup
// dataset, which omits the numeric code). `unknown` covers undocumented
// codes / missing values — coercing those to a definite state would
// misreport live entities.
export type GcisCompanyStatus =
  | { type: "active" }
  | { type: "suspended" }
  | { type: "dissolved" }
  | { type: "unknown" };

export type GcisCompany = {
  // 統一編號 — the 8-digit canonical ID, kept as a string to preserve
  // leading zeros (e.g. Foxconn's "04541302").
  taxId: string;
  // Registered Chinese name (`公司名稱`). Surfaced verbatim.
  name: string;
  // Capital figures in TWD, or null when the upstream omits them.
  // GCIS reports zero for many sub-entities (e.g. foreign branches);
  // we preserve the zero rather than coercing it to null so callers
  // can tell "no record" from "filed as zero".
  capitalAmount: number | null;
  paidInCapitalAmount: number | null;
  // 負責人 (responsible person). Chinese name string.
  responsibleName: string | null;
  // 公司所在地 — single free-form Chinese address string. GCIS does
  // not expose structured atoms (street / postal code / city) so the
  // adapter cannot split this further without best-effort parsing
  // that we explicitly defer.
  location: string | null;
  // 登記機關 — registering authority (typically a city government or
  // the central Commerce Development Department under the MoEA).
  registerOrganization: string | null;
  // ROC-era dates as captured upstream (`YYYMMDD`). Conversion to
  // Gregorian happens in the parsed `*GregorianDate` fields; both
  // are surfaced so consumers can render the original.
  setupDateRoc: string | null;
  setupDate: string | null;
  lastChangeDateRoc: string | null;
  lastChangeDate: string | null;
  status: GcisCompanyStatus;
  statusDescription: string | null;
  registryUrl: string;
};

export type GcisSearchResult = {
  taxId: string;
  name: string;
  location: string | null;
  status: GcisCompanyStatus;
};
