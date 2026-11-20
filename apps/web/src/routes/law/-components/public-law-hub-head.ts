import { hasSearch } from "@/features/case-law/browse-hub-path";
import { getTranslator } from "@/i18n/i18n-store";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";

/**
 * What a public law hub's head says, worked out by the hub's loader. A
 * route's `head` runs in the route tree every cold visit loads, while its
 * loader loads with the route; so the loader names the hub (its title, its
 * sentence, its address and the decisions it lists) and the head only turns
 * that into tags. The loader re-runs on a locale change, as the head did.
 */
export type PublicLawHubHeadData = {
  title: string;
  description: string;
  path: `/law/${string}`;
  items: readonly { name: string; url: string }[];
};

/** A hub's head tags, from its loader's data and the URL's search. */
export const createPublicLawHubHead = (
  data: PublicLawHubHeadData | undefined,
  search: object,
) => {
  if (data === undefined) {
    return {};
  }
  const { description, items, path, title } = data;
  return createPublicLawHead({
    // Any query string makes this a variant of the hub, never the hub; the
    // variant's canonical link names the hub.
    indexing: hasSearch(search) ? "noindex" : "default",
    canonicalPath: path,
    description,
    jsonLd: createLegalCollectionJsonLd({
      t: getTranslator(),
      canonicalUrl: createPublicLawCanonicalUrl(path),
      description,
      kind: "caseLaw",
      items,
      name: title,
    }),
    path,
    title: pageTitleLiteral(title),
    type: "website",
  });
};
