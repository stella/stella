const PUBLIC_LEGAL_MATERIAL_TYPES = {
  guidelines: "guidelines",
  regulations: "regulations",
  statutes: "statutes",
  treaties: "treaties",
} as const;

const LANGUAGE_SEGMENT_REGEX = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

export type PublicLegalMaterialType =
  (typeof PUBLIC_LEGAL_MATERIAL_TYPES)[keyof typeof PUBLIC_LEGAL_MATERIAL_TYPES];

export type PublicLegalMaterialRouteParams = {
  authority: string;
  language?: string;
  materialType: PublicLegalMaterialType;
  slug: string;
  version?: string;
};

export type PublicLegalMaterialRouteInput = {
  authority: string;
  language?: string | null;
  languageAlternateCount?: number | null;
  languageAlternates?: readonly unknown[] | null;
  materialType: PublicLegalMaterialType;
  slug: string;
  title?: string | null;
  version?: string | null;
};

export const normalizePublicLegalMaterialLanguageSegment = (
  language: string | null | undefined,
): string | null => {
  const normalized = language?.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized || !LANGUAGE_SEGMENT_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

export const shouldUsePublicLegalMaterialLanguageSegment = ({
  language,
  languageAlternateCount,
  languageAlternates,
}: {
  language?: string | null | undefined;
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
}): boolean => {
  const alternateCount =
    languageAlternateCount ?? languageAlternates?.length ?? 0;

  return (
    normalizePublicLegalMaterialLanguageSegment(language) !== null &&
    alternateCount > 1
  );
};

export const createPublicLegalMaterialRouteParams = ({
  authority,
  language,
  languageAlternateCount,
  languageAlternates,
  materialType,
  slug,
  title,
  version,
}: PublicLegalMaterialRouteInput): PublicLegalMaterialRouteParams => {
  const stableSlug =
    normalizePublicLegalMaterialPathSegment(slug) ??
    normalizePublicLegalMaterialPathSegment(title ?? "") ??
    "untitled";
  const versionSegment = normalizePublicLegalMaterialVersionSegment(version);
  const baseParams = {
    authority: normalizePublicLegalMaterialPathSegment(authority) ?? "unknown",
    materialType,
    slug: stableSlug,
    ...(versionSegment ? { version: versionSegment } : {}),
  };

  if (
    !shouldUsePublicLegalMaterialLanguageSegment({
      language,
      languageAlternateCount,
      languageAlternates,
    })
  ) {
    return baseParams;
  }

  const languageSegment = normalizePublicLegalMaterialLanguageSegment(language);
  if (languageSegment === null) {
    return baseParams;
  }

  return {
    ...baseParams,
    language: languageSegment,
  };
};

export const createPublicLegalMaterialPath = ({
  authority,
  language,
  materialType,
  slug,
  version,
}: PublicLegalMaterialRouteParams): `/law/${string}/${string}/${string}` => {
  const basePath = `/law/${materialType}/${authority}/${slug}` as const;
  if (!version) {
    if (language) {
      return `${basePath}/lang/${language}`;
    }

    return basePath;
  }

  const versionedPath = `${basePath}/v/${version}` as const;
  if (language) {
    return `${versionedPath}/lang/${language}`;
  }

  return versionedPath;
};

const normalizePublicLegalMaterialVersionSegment = (
  version: string | null | undefined,
): string | null => normalizePublicLegalMaterialPathSegment(version ?? "");

const normalizePublicLegalMaterialPathSegment = (
  value: string,
): string | null => {
  const normalized = trimHyphens(
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return normalized.length > 0 ? normalized : null;
};

const trimHyphens = (value: string): string => {
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
