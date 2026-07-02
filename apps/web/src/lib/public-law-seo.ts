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

type CaseLawCollectionJsonLdInput = {
  canonicalUrl: string;
  description?: string | null;
  items?: readonly {
    name: string;
    url: string;
  }[];
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

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
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

export const createCaseLawCollectionJsonLd = ({
  canonicalUrl,
  description,
  items = [],
  name,
}: CaseLawCollectionJsonLdInput): JsonLdObject => {
  const itemList: JsonLdObject = {
    "@type": "ItemList",
    name,
  };

  if (items.length > 0) {
    itemList["itemListElement"] = items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "LegalDocument",
        name: item.name,
        url: item.url,
      },
    }));
  }

  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    about: {
      "@type": "LegalDocument",
      name: "Case-law decisions",
    },
    mainEntity: itemList,
    name,
    url: canonicalUrl,
    ...(description?.trim() ? { description } : {}),
  };
};
