import { parseDeterministicDate } from "@/lib/deterministic-date";
import { isPublicLawCrawlAllowed } from "@/lib/public-law-launch";
import {
  createPublicCanonicalUrl,
  createPublicHead,
  type JsonLdObject,
  type PublicHeadInput,
} from "@/lib/public-seo";

type PublicLawHeadInput = Omit<PublicHeadInput, "crawlAllowed"> & {
  crawlAllowed?: boolean;
};

type CaseLawDecisionJsonLdInput = {
  canonicalUrl: string;
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  decisionType?: string | null;
  ecli: string | null;
  language: string;
  sourceName?: string | null;
  sourceUrl?: string | null;
  updatedAt?: Date | string | null;
};

type StatuteJsonLdInput = {
  canonicalUrl: string;
  country: string;
  documentType: string | null;
  eli: string;
  language: string;
  sourceUrl?: string | null;
  title: string;
  versionValidFrom: string | null;
};

/**
 * What the collection collects, as the schema.org type its subject and its
 * entries carry: statutes are `Legislation`, decisions are `LegalDocument`.
 */
const LEGAL_COLLECTION_TYPES = {
  caseLaw: "LegalDocument",
  statutes: "Legislation",
} as const;

type LegalCollectionKind = keyof typeof LEGAL_COLLECTION_TYPES;

type LegalCollectionJsonLdInput = {
  /** What the collection is a collection of, e.g. "Statutes". */
  aboutName: string;
  canonicalUrl: string;
  description?: string | null;
  items?: readonly {
    name: string;
    url: string;
  }[];
  kind: LegalCollectionKind;
  name: string;
};

const dateToIsoDate = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }

  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    return raw;
  }

  return parseDeterministicDate(raw)?.toISOString().slice(0, 10) ?? null;
};

const absoluteUrlOrNull = (value: string | null | undefined): string | null => {
  if (!value?.trim()) {
    return null;
  }

  return URL.canParse(value) ? value : null;
};

export const createPublicLawCanonicalUrl = createPublicCanonicalUrl;

export const createPublicLawHead = ({
  crawlAllowed = isPublicLawCrawlAllowed(),
  ...rest
}: PublicLawHeadInput) => createPublicHead({ crawlAllowed, ...rest });

export const createCaseLawDecisionJsonLd = ({
  canonicalUrl,
  caseNumber,
  country,
  court,
  decisionDate,
  decisionType,
  ecli,
  language,
  sourceName,
  sourceUrl,
  updatedAt,
}: CaseLawDecisionJsonLdInput): JsonLdObject => {
  const publishedDate = dateToIsoDate(decisionDate);
  const modifiedDate = dateToIsoDate(updatedAt ?? null);
  const officialSourceUrl = absoluteUrlOrNull(sourceUrl);
  const citations = [caseNumber, ecli].filter(
    (value): value is string => value !== null && value.trim().length > 0,
  );

  return {
    "@context": "https://schema.org",
    "@type": "LegalDocument",
    citation: citations,
    identifier: ecli ?? caseNumber,
    inLanguage: language,
    isPartOf: {
      "@type": "Collection",
      name: "Stella case law",
    },
    mainEntityOfPage: {
      "@id": canonicalUrl,
      "@type": "WebPage",
    },
    name: caseNumber,
    publisher: {
      "@type": "Organization",
      name: court,
    },
    spatialCoverage: country,
    url: canonicalUrl,
    ...(publishedDate ? { datePublished: publishedDate } : {}),
    ...(modifiedDate ? { dateModified: modifiedDate } : {}),
    ...(decisionType?.trim() ? { genre: decisionType } : {}),
    ...(officialSourceUrl ? { sameAs: officialSourceUrl } : {}),
    ...(sourceName?.trim()
      ? {
          provider: {
            "@type": "Organization",
            name: sourceName,
          },
        }
      : {}),
  };
};

export const createStatuteJsonLd = ({
  canonicalUrl,
  country,
  documentType,
  eli,
  language,
  sourceUrl,
  title,
  versionValidFrom,
}: StatuteJsonLdInput): JsonLdObject => {
  // `version_valid_from` opens this consolidation's validity window, which is
  // schema.org's `legislationDateVersion`. It is not the date the text was
  // adopted or signed, so it must not be emitted as `legislationDate`.
  const versionDate = dateToIsoDate(versionValidFrom);
  const officialSourceUrl = absoluteUrlOrNull(sourceUrl);

  return {
    "@context": "https://schema.org",
    "@type": "Legislation",
    inLanguage: language,
    legislationIdentifier: eli,
    legislationJurisdiction: country,
    mainEntityOfPage: {
      "@id": canonicalUrl,
      "@type": "WebPage",
    },
    name: title,
    url: canonicalUrl,
    ...(versionDate ? { legislationDateVersion: versionDate } : {}),
    ...(documentType?.trim() ? { legislationType: documentType } : {}),
    ...(officialSourceUrl ? { sameAs: officialSourceUrl } : {}),
  };
};

export const createLegalCollectionJsonLd = ({
  aboutName,
  canonicalUrl,
  description,
  items = [],
  kind,
  name,
}: LegalCollectionJsonLdInput): JsonLdObject => {
  const itemType = LEGAL_COLLECTION_TYPES[kind];
  const itemList: JsonLdObject = {
    "@type": "ItemList",
    name,
  };

  if (items.length > 0) {
    itemList["itemListElement"] = items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": itemType,
        name: item.name,
        url: item.url,
      },
    }));
  }

  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    about: {
      "@type": itemType,
      name: aboutName,
    },
    mainEntity: itemList,
    name,
    url: canonicalUrl,
    ...(description?.trim() ? { description } : {}),
  };
};
