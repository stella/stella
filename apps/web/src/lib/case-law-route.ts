const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const COMPACT_UUID_REGEX = /^[A-Za-z0-9_-]{22}$/u;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type CaseLawDecisionSearchHit = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  decisionId: string;
  ecli: string | null;
  language?: string | null;
  languageAlternateCount?: number | null;
  languageAlternates?: readonly unknown[] | null;
  slug?: string | null;
};

export type CaseLawDecisionRouteParams = {
  country: string;
  court: string;
  date: string;
  language?: string;
  slug: string;
};

export const isCaseLawDecisionId = (value: string): boolean =>
  UUID_REGEX.test(value.trim());

const uuidToBytes = (uuid: string): number[] | null => {
  const hex = uuid.replace(/-/gu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(hex)) {
    return null;
  }

  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }

  return bytes;
};

const bytesToUuid = (bytes: readonly number[]): string | null => {
  if (bytes.length !== 16) {
    return null;
  }

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const encodeBase64Url = (bytes: readonly number[]): string => {
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;
    const triplet = first * 65_536 + second * 256 + third;

    encoded += BASE64URL_ALPHABET[Math.floor(triplet / 262_144) % 64] ?? "";
    encoded += BASE64URL_ALPHABET[Math.floor(triplet / 4096) % 64] ?? "";
    if (remaining > 1) {
      encoded += BASE64URL_ALPHABET[Math.floor(triplet / 64) % 64] ?? "";
    }
    if (remaining > 2) {
      encoded += BASE64URL_ALPHABET[triplet % 64] ?? "";
    }
  }

  return encoded;
};

const decodeBase64Url = (value: string): number[] | null => {
  if (!COMPACT_UUID_REGEX.test(value)) {
    return null;
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;

  for (const char of value) {
    const sixBits = BASE64URL_ALPHABET.indexOf(char);
    if (sixBits === -1) {
      return null;
    }

    buffer = buffer * 64 + sixBits;
    bitCount += 6;

    while (bitCount >= 8) {
      bitCount -= 8;
      const divisor = 2 ** bitCount;
      bytes.push(Math.floor(buffer / divisor) % 256);
      buffer %= divisor;
    }
  }

  return bytes.length === 16 ? bytes : null;
};

export const encodeCaseLawDecisionIdForRoute = (decisionId: string): string => {
  const bytes = uuidToBytes(decisionId.trim());
  return bytes ? encodeBase64Url(bytes) : decisionId;
};

export const decodeCaseLawDecisionIdFromRoute = (
  decisionId: string,
): string => {
  const trimmed = decisionId.trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const bytes = decodeBase64Url(trimmed);
  return bytesToUuid(bytes ?? []) ?? trimmed;
};

const trimSlugHyphens = (value: string): string => {
  let start = 0;
  while (value.at(start) === "-") {
    start += 1;
  }

  let end = value.length;
  while (end > start && value.at(end - 1) === "-") {
    end -= 1;
  }

  return value.slice(start, end);
};

const slugifyCaseLawPathSegment = (value: string): string => {
  const slug = trimSlugHyphens(
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return slug.length > 0 ? slug : "unknown";
};

export const slugifyCaseLawCaseNumber = (caseNumber: string): string =>
  slugifyCaseLawPathSegment(caseNumber);

export const normalizeCaseLawStoredSlug = (
  slug: string | null | undefined,
): string | null => {
  if (!slug?.trim()) {
    return null;
  }

  return slugifyCaseLawPathSegment(slug);
};

export const createStableCaseLawSlug = ({
  caseNumber,
  slug,
}: {
  caseNumber: string;
  slug?: string | null | undefined;
}): string =>
  normalizeCaseLawStoredSlug(slug) ?? slugifyCaseLawCaseNumber(caseNumber);

export const createCaseLawDecisionRouteParam = ({
  caseNumber,
  slug,
}: {
  caseNumber: string;
  slug?: string | null | undefined;
}): string => createStableCaseLawSlug({ caseNumber, slug });

export const extractCaseLawDecisionIdFromRouteParam = (
  param: string,
): string => {
  const sep = param.lastIndexOf("--");
  return decodeCaseLawDecisionIdFromRoute(
    sep === -1 ? param : param.slice(sep + 2),
  );
};

export const extractLegacyCaseLawDecisionIdFromRouteParam = (
  param: string,
): string | null => {
  const sep = param.lastIndexOf("--");
  if (sep === -1) {
    return null;
  }

  const decoded = decodeCaseLawDecisionIdFromRoute(param.slice(sep + 2));
  return isCaseLawDecisionId(decoded) ? decoded : null;
};

const UNKNOWN_DATE_SEGMENT = "unknown-date";
const UNKNOWN_COURT_SEGMENT = "unknown-court";
const LANGUAGE_SEGMENT_REGEX = /^(?=.{2,8}$)[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

const formatDecisionDateSegment = (value: Date | string | null): string => {
  if (value === null) {
    return UNKNOWN_DATE_SEGMENT;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? UNKNOWN_DATE_SEGMENT
      : value.toISOString().slice(0, 10);
  }

  const rawDate = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(rawDate)) {
    return rawDate;
  }

  const date = new Date(rawDate);
  return Number.isNaN(date.getTime())
    ? UNKNOWN_DATE_SEGMENT
    : date.toISOString().slice(0, 10);
};

export const createCaseLawDecisionRouteParams = ({
  caseNumber,
  country,
  court,
  decisionDate,
  language,
  languageAlternateCount,
  languageAlternates,
  slug,
}: {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  decisionId: string;
  language?: string | null | undefined;
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
}): CaseLawDecisionRouteParams => {
  const languageSegment = normalizeCaseLawLanguageSegment(language);
  const baseParams = {
    country: country.toLowerCase(),
    court:
      court.trim().length > 0
        ? slugifyCaseLawPathSegment(court)
        : UNKNOWN_COURT_SEGMENT,
    date: formatDecisionDateSegment(decisionDate),
    slug: createCaseLawDecisionRouteParam({ caseNumber, slug }),
  };

  if (
    !shouldUseCaseLawLanguageSegment({
      language,
      languageAlternateCount,
      languageAlternates,
    })
  ) {
    return baseParams;
  }

  if (languageSegment === null) {
    return baseParams;
  }

  return {
    ...baseParams,
    language: languageSegment,
  };
};

export const normalizeCaseLawLanguageSegment = (
  language: string | null | undefined,
): string | null => {
  const normalized = language?.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized || !LANGUAGE_SEGMENT_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

export const shouldUseCaseLawLanguageSegment = ({
  language,
  languageAlternateCount,
  languageAlternates,
}: {
  language?: string | null | undefined;
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
}): boolean =>
  normalizeCaseLawLanguageSegment(language) !== null &&
  getCaseLawLanguageAlternateCount({
    languageAlternateCount,
    languageAlternates,
  }) > 1;

const getCaseLawLanguageAlternateCount = ({
  languageAlternateCount,
  languageAlternates,
}: {
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
}): number => {
  if (languageAlternateCount !== null && languageAlternateCount !== undefined) {
    return languageAlternateCount;
  }

  if (!languageAlternates) {
    return 0;
  }

  const languages = new Set<string>();
  for (const alternate of languageAlternates) {
    if (!isCaseLawLanguageAlternate(alternate)) {
      continue;
    }

    const normalized = normalizeCaseLawLanguageSegment(alternate.language);
    if (normalized !== null) {
      languages.add(normalized);
    }
  }

  return languages.size;
};

const isCaseLawLanguageAlternate = (
  alternate: unknown,
): alternate is { language: string } =>
  typeof alternate === "object" &&
  alternate !== null &&
  "language" in alternate &&
  typeof alternate.language === "string";

export const createCaseLawDecisionPath = ({
  country,
  court,
  date,
  language,
  slug,
}: CaseLawDecisionRouteParams): `/law/${string}/cases/${string}/${string}/${string}` => {
  if (language) {
    return `/law/${country}/cases/${court}/${date}/${language}/${slug}`;
  }

  return `/law/${country}/cases/${court}/${date}/${slug}`;
};

export const decodeCaseLawDecisionRef = (value: string): string => {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
};

const normalizeDecisionRef = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export const pickCaseLawDecisionHit = (
  decisionRef: string,
  hits: readonly CaseLawDecisionSearchHit[],
): CaseLawDecisionSearchHit | null => {
  const normalizedRef = normalizeDecisionRef(decisionRef);
  const exactCaseNumber = hits.find(
    (hit) => normalizeDecisionRef(hit.caseNumber) === normalizedRef,
  );

  if (exactCaseNumber) {
    return exactCaseNumber;
  }

  const exactEcli = hits.find(
    (hit) =>
      hit.ecli !== null && normalizeDecisionRef(hit.ecli) === normalizedRef,
  );

  return exactEcli ?? hits.at(0) ?? null;
};
