import { env } from "@/env";

export type JsonLdObject = Record<string, unknown>;

export type PublicAlternateLink = {
  href: string;
  hreflang: string;
};

export type PublicHeadInput = {
  alternateLinks?: readonly PublicAlternateLink[];
  crawlAllowed: boolean;
  description?: string | null;
  jsonLd?: JsonLdObject | null;
  path: `/${string}`;
  title: string;
  type: "article" | "website";
};

type PublicMeta =
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

const PUBLIC_ROBOTS =
  "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1";
const PRIVATE_ROBOTS = "noindex,nofollow";

const trimTrailingSlash = (value: string): string => {
  if (value.endsWith("/") && value.length > 1) {
    return value.slice(0, -1);
  }

  return value;
};

const serializeJsonLd = (value: JsonLdObject): string =>
  JSON.stringify(value).replace(/</gu, "\\u003c");

export const createPublicCanonicalUrl = (path: `/${string}`): string =>
  new URL(path, `${trimTrailingSlash(env.VITE_PUBLIC_APP_URL)}/`).toString();

/**
 * Shared public-surface `head:` builder. Callers own the crawl flag
 * (each public namespace has its own dark-launch gate; crawl permission
 * additionally requires the deployment to be marked indexable); everything
 * else — canonical link, robots flip, Open Graph, Twitter card, optional
 * JSON-LD — is identical across surfaces.
 */
export const createPublicHead = ({
  alternateLinks = [],
  crawlAllowed,
  description,
  jsonLd,
  path,
  title,
  type,
}: PublicHeadInput) => {
  const canonicalUrl = createPublicCanonicalUrl(path);
  const links = [
    { rel: "canonical", href: canonicalUrl },
    ...alternateLinks.map((link) => ({
      rel: "alternate",
      hreflang: link.hreflang,
      href: link.href,
    })),
  ];
  const meta: PublicMeta[] = [
    { title },
    {
      name: "robots",
      content: crawlAllowed ? PUBLIC_ROBOTS : PRIVATE_ROBOTS,
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
