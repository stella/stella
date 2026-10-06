import { Result } from "better-result";

import {
  type CaseLawDecisionRouteParams,
  parseCaseLawDecisionPath,
} from "./case-law-decision-route";
import { parseStatutePath, type StatuteRouteParams } from "./statute-route";

export type LegalCitationLinks =
  | {
      type: "statute";
      params: StatuteRouteParams;
      url: string;
      source_url?: string;
    }
  | {
      type: "decision";
      params: CaseLawDecisionRouteParams;
      url: string;
      source_url?: string;
    }
  | { type: "external"; url: string | null };

type ResolveLegalCitationLinksOptions = {
  /** A corpus reader URL, absent when this deployment cannot serve the item. */
  appUrl: string | null;
  /** The publisher URL, preserved separately from the primary reader link. */
  sourceUrl: string | null;
  appOrigins: ReadonlySet<string>;
};

export const parseLegalCitationHttpUrl = (
  value: string | null,
  base?: string,
): URL | null => {
  if (value === null || (!value.startsWith("/") && !URL.canParse(value))) {
    return null;
  }
  const parsed = Result.try(() => new URL(value, base)).unwrapOr(null);
  return parsed?.protocol === "https:" || parsed?.protocol === "http:"
    ? parsed
    : null;
};

/** The primary legal citation always opens a served corpus item before its publisher. */
export const resolveLegalCitationLinks = ({
  appUrl,
  appOrigins,
  sourceUrl,
}: ResolveLegalCitationLinksOptions): LegalCitationLinks => {
  const base = appOrigins.values().next().value;
  const internal = parseLegalCitationHttpUrl(appUrl, base);
  const source = parseLegalCitationHttpUrl(sourceUrl, base);
  if (internal === null || !appOrigins.has(internal.origin)) {
    return { type: "external", url: source?.href ?? null };
  }

  const sourceLink =
    source !== null && source.href !== internal.href
      ? { source_url: source.href }
      : {};
  const statute = parseStatutePath(internal.pathname);
  if (statute !== null) {
    return {
      type: "statute",
      params: statute,
      url: internal.href,
      ...sourceLink,
    };
  }
  const decision = parseCaseLawDecisionPath(internal.pathname);
  if (decision !== null) {
    return {
      type: "decision",
      params: decision,
      url: internal.href,
      ...sourceLink,
    };
  }
  return { type: "external", url: source?.href ?? null };
};
