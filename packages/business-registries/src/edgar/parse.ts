import type {
  EdgarAddress,
  EdgarCompany,
  EdgarEntityStatus,
  EdgarFiling,
  EdgarFormerName,
  EdgarRawAddress,
  EdgarRawFormerName,
  EdgarRawRecentFilings,
  EdgarRawSubmission,
} from "./types.js";

const EDGAR_BROWSE_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=";

// Recent filings the chat tool surfaces by default. The full list
// (thousands of rows for big issuers) stays in `filings.files` for
// callers that need to paginate.
const RECENT_FILINGS_LIMIT = 5;

// "Stale" cutoff for derived status. If the most recent filing is
// older than this, the entity needs caller review. EDGAR keeps every
// issuer it has ever known forever, so an old filing history is not
// enough to infer a lifecycle event such as delisting.
const STALE_FILING_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const nonEmpty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const parseAddress = (raw: EdgarRawAddress): EdgarAddress => {
  const street = [nonEmpty(raw.street1), nonEmpty(raw.street2)]
    .filter(Boolean)
    .join(", ");
  // SEC encodes US states in `stateOrCountry` (two-letter codes) and
  // non-US locations in `stateOrCountryDescription` / `country`. Both
  // can be empty; prefer the description, fall back to the code.
  const region =
    nonEmpty(raw.stateOrCountryDescription) ?? nonEmpty(raw.stateOrCountry);
  const city = nonEmpty(raw.city);
  const postalCode = nonEmpty(raw.zipCode);
  const country = nonEmpty(raw.country) ?? nonEmpty(raw.countryCode);

  const composite = [
    street.length > 0 ? street : null,
    [postalCode, city].filter(Boolean).join(" ") || null,
    region,
    country,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    street: street.length > 0 ? street : null,
    city,
    region,
    postalCode,
    country,
    textAddress: composite.length > 0 ? composite : null,
  };
};

const parseFormerName = (raw: EdgarRawFormerName): EdgarFormerName => ({
  name: raw.name,
  from: nonEmpty(raw.from ?? null),
  to: nonEmpty(raw.to ?? null),
});

// `filings.recent` is a structure-of-arrays. Zip the first N entries
// into per-filing records, tolerating shorter sibling arrays (which
// EDGAR does emit when a column is uniformly empty).
const parseRecentFilings = (
  raw: EdgarRawRecentFilings | undefined,
): EdgarFiling[] => {
  if (!raw) {
    return [];
  }
  const accession = raw.accessionNumber ?? [];
  const filings: EdgarFiling[] = [];
  for (
    let i = 0;
    i < accession.length && filings.length < RECENT_FILINGS_LIMIT;
    i++
  ) {
    const accessionNumber = accession[i];
    const form = raw.form?.[i];
    const filingDate = raw.filingDate?.[i];
    if (!accessionNumber || !form || !filingDate) {
      continue;
    }
    filings.push({
      accessionNumber,
      form,
      filingDate,
      reportDate: nonEmpty(raw.reportDate?.[i] ?? null),
      acceptanceDateTime: nonEmpty(raw.acceptanceDateTime?.[i] ?? null),
      primaryDocument: nonEmpty(raw.primaryDocument?.[i] ?? null),
      primaryDocDescription: nonEmpty(raw.primaryDocDescription?.[i] ?? null),
    });
  }
  return filings;
};

const deriveStatus = (
  entityType: string | undefined,
  recentFilings: readonly EdgarFiling[],
  now: number,
): EdgarEntityStatus => {
  const mostRecent = recentFilings.at(0);
  // No filings at all -> we can't tell; the issuer may have been
  // registered for a single transaction decades ago.
  if (!mostRecent) {
    return { type: "unknown" };
  }
  const filedAt = Date.parse(mostRecent.filingDate);
  if (Number.isNaN(filedAt)) {
    return { type: "unknown" };
  }
  if (now - filedAt > STALE_FILING_AGE_MS) {
    return { type: "stale", lastFilingDate: mostRecent.filingDate };
  }
  if (entityType === "operating") {
    return { type: "active" };
  }
  return { type: "unknown" };
};

export type ParseSubmissionOptions = {
  /**
   * Reference timestamp used to derive `status`. Defaults to the
   * current wall clock; tests pin a fixed value so the derived status
   * stays deterministic regardless of fixture age.
   */
  now?: number;
};

export const parseSubmission = (
  raw: EdgarRawSubmission,
  options?: ParseSubmissionOptions,
): EdgarCompany => {
  const recentFilings = parseRecentFilings(raw.filings?.recent);
  const status = deriveStatus(
    raw.entityType,
    recentFilings,
    options?.now ?? Date.now(),
  );
  const cik = raw.cik;

  return {
    cik,
    name: raw.name,
    sic: nonEmpty(raw.sic ?? null),
    sicDescription: nonEmpty(raw.sicDescription ?? null),
    tickers: raw.tickers ?? [],
    exchanges: raw.exchanges ?? [],
    ein: nonEmpty(raw.ein ?? null),
    addresses: {
      mailing: raw.addresses?.mailing
        ? parseAddress(raw.addresses.mailing)
        : null,
      business: raw.addresses?.business
        ? parseAddress(raw.addresses.business)
        : null,
    },
    formerNames: (raw.formerNames ?? []).map(parseFormerName),
    recentFilings,
    status,
    // Browse-EDGAR accepts the zero-padded or unpadded CIK; using the
    // padded form keeps the URL stable and matches the JSON field.
    registryUrl: `${EDGAR_BROWSE_URL}${cik}`,
  };
};
