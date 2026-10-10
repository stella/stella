import { panic, Result } from "better-result";
import * as v from "valibot";

import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import {
  createStatuteRouteParams,
  type StatuteRouteParams,
} from "@stll/api-contract/statute-route";

import { createStatuteViewTab } from "@/features/statutes/statute-inspector.logic";
import { publicStatuteSearchSchema } from "@/features/statutes/statute-page-search";
import type { StatuteRouteResolution } from "@/features/statutes/statute-route-resolution";

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

/**
 * What a resolved statute link opens: a `wording` to show (a tab beside the
 * chat, or its page on a phone), or the act's page on a `day` the
 * publisher's own inconsistent dates leave unanswered. Only that page says
 * why; the Work's default wording would read as the answer for the day.
 */
export type StatuteLinkOpening<Statute> =
  | { type: "wording"; statute: Statute }
  | { type: "day"; asOf: string; work: Statute };

export const statuteLinkOpening = <Statute>(
  resolution: StatuteRouteResolution<Statute>,
): StatuteLinkOpening<Statute> | null => {
  switch (resolution.type) {
    case "found":
      // A day nothing was in force on opens the act, as the page redirects.
      return {
        type: "wording",
        statute: resolution.statute ?? resolution.work,
      };
    case "window-gap":
      return { type: "day", asOf: resolution.asOf, work: resolution.work };
    case "missing":
    case "unserved":
      return null;
    default:
      resolution satisfies never;
      return panic(`Unhandled resolution: ${String(resolution)}`);
  }
};

/**
 * The act's page read on a day: the bare address with `?asOf`, never the
 * `/v/` opening, which names a consolidation and so redirects away from a
 * day none answers.
 */
export const createStatuteDayTarget = (work: LinkedStatute, asOf: string) => {
  const params = createStatuteRouteParams({
    country: work.country,
    documentId: work.id,
    eli: work.eli,
    slug: work.slug,
    version: null,
  });

  return {
    params: { country: params.country, slug: params.slug },
    search: { asOf },
    to: "/law/$country/statutes/$slug",
  } as const;
};

/** `appOrigins`: the origins this app answers on (the page's, the public URL). */
export const classifyChatHttpLink = (
  url: URL,
  appOrigins: ReadonlySet<string>,
): ChatHttpLink => {
  const resolved = resolveLegalCitationLinks({
    appUrl: url.href,
    sourceUrl: url.href,
    appOrigins,
  });
  switch (resolved.type) {
    case "decision":
      return { type: "decision", params: resolved.params };
    case "statute":
      return {
        type: "statute",
        link: {
          anchor: readAnchor(url.hash),
          asOf: readAsOf(url.searchParams),
          params: resolved.params,
        },
      };
    case "external":
      return { type: "external" };
    default:
      resolved satisfies never;
      return panic(`Unhandled legal citation: ${String(resolved)}`);
  }
};
