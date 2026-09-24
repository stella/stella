import { Result } from "better-result";
import * as v from "valibot";

import {
  type CaseLawDecisionRouteParams,
  parseCaseLawDecisionPath,
} from "@stll/api-contract/case-law-decision-route";
import {
  parseStatutePath,
  type StatuteRouteParams,
} from "@stll/api-contract/statute-route";

import { createStatuteViewTab } from "@/features/statutes/statute-inspector.logic";
import { publicStatuteSearchSchema } from "@/routes/law/-statute-detail.logic";

/**
 * A statute page's address, the `?asOf` day it asks the act on, and the
 * provision anchor it lands on, each null when the link names none.
 */
export type StatuteLink = {
  anchor: string | null;
  asOf: string | null;
  params: StatuteRouteParams;
};

/**
 * What an http link in a chat answer names. A link to one of this app's own
 * decision or statute pages is that record, not a web page to preview: a tool
 * hands the model those URLs, and a user pastes them.
 */
export type ChatHttpLink =
  | { type: "decision"; params: CaseLawDecisionRouteParams }
  | { type: "statute"; link: StatuteLink }
  | { type: "external" };

const readAnchor = (hash: string): string | null => {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment === "") {
    return null;
  }

  return Result.try(() => decodeURIComponent(fragment)).unwrapOr(null);
};

/** The `?asOf` day, read by the statute page's own search schema. */
const readAsOf = (searchParams: URLSearchParams): string | null => {
  const search = v.safeParse(
    publicStatuteSearchSchema,
    Object.fromEntries(searchParams),
  );
  return search.success ? (search.output.asOf ?? null) : null;
};

/** The consolidation a statute link resolved to, as the corpus reads it. */
type LinkedStatute = {
  country: string;
  eli: string | null;
  id: string;
  slug: string | null;
  title: string;
  versionValidFrom: string | null;
};

/** The inspector tab a statute link opens: the act, landing on its anchor. */
export const createStatuteLinkTab = (
  statute: LinkedStatute,
  { anchor }: StatuteLink,
) =>
  createStatuteViewTab({
    country: statute.country,
    documentId: statute.id,
    eli: statute.eli,
    slug: statute.slug,
    statuteTitle: statute.title,
    versionValidFrom: statute.versionValidFrom,
    ...(anchor === null ? {} : { anchorId: anchor }),
  });

/** `appOrigins`: the origins this app answers on (the page's, the public URL). */
export const classifyChatHttpLink = (
  url: URL,
  appOrigins: ReadonlySet<string>,
): ChatHttpLink => {
  if (!appOrigins.has(url.origin)) {
    return { type: "external" };
  }

  const decision = parseCaseLawDecisionPath(url.pathname);
  if (decision !== null) {
    return { type: "decision", params: decision };
  }

  const statute = parseStatutePath(url.pathname);
  if (statute !== null) {
    return {
      type: "statute",
      link: {
        anchor: readAnchor(url.hash),
        asOf: readAsOf(url.searchParams),
        params: statute,
      },
    };
  }

  return { type: "external" };
};
