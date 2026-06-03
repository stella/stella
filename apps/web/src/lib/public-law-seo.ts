import { env } from "@/env";
import { isPublicLawIndexingEnabled } from "@/lib/public-law-launch";

type JsonLdObject = Record<string, unknown>;

type PublicLawHeadInput = {
  alternateLinks?: readonly PublicLawAlternateLink[];
  description?: string | null;
  indexingEnabled?: boolean;
  jsonLd?: JsonLdObject | null;
  path: `/${string}`;
  title: string;
  type: "article" | "website";
};

type PublicLawMeta =
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

type PublicLawAlternateLink = {
  href: string;
  hreflang: string;
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

const PUBLIC_ROBOTS =
  "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1";
const PRIVATE_ROBOTS = "noindex,nofollow";

const trimTrailingSlash = (value: string): string => {
  if (value.endsWith("/") && value.length > 1) {
    return value.slice(0, -1);
  }

  return value;
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

const serializeJsonLd = (value: JsonLdObject): string =>
  JSON.stringify(value).replace(/</gu, "\\u003c");

export const createPublicLawCanonicalUrl = (path: `/${string}`): string =>
  new URL(path, `${trimTrailingSlash(env.VITE_PUBLIC_APP_URL)}/`).toString();

export const createPublicLawHead = ({
  alternateLinks = [],
  description,
  indexingEnabled = isPublicLawIndexingEnabled(),
  jsonLd,
  path,
  title,
  type,
}: PublicLawHeadInput) => {
  const canonicalUrl = createPublicLawCanonicalUrl(path);
  const links = [
    { rel: "canonical", href: canonicalUrl },
    ...alternateLinks.map((link) => ({
      rel: "alternate",
      hreflang: link.hreflang,
      href: link.href,
    })),
  ];
  const meta: PublicLawMeta[] = [
    { title },
    {
      name: "robots",
      content: indexingEnabled ? PUBLIC_ROBOTS : PRIVATE_ROBOTS,
    },
    { property: "og:title", content: title },
    { property: "og:type", content: type },
    { property: "og:url", content: canonicalUrl },
    { name: "twitter:card", content: "summary" },
  ];

  if (description?.trim()) {
    meta.push(
      { name: "description", content: description },
      { property: "og:description", content: description },
    );
  }

  return {
    links,
    meta,
    ...(jsonLd
      ? {
          scripts: [
            {
              children: serializeJsonLd(jsonLd),
              type: "application/ld+json",
            },
          ],
        }
      : {}),
  };
};

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
