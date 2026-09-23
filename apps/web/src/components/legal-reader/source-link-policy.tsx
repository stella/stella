/**
 * Which hyperlinks in a source document the reader renders.
 *
 * A court's document is typeset with links of its own: to its own site, and —
 * where the court's publisher has one — into a commercial legal database for
 * every statute the decision cites. Rendering that markup verbatim sends the
 * reader out of the corpus for text the corpus holds, under our own chrome and
 * often to a paywall. A statute reference belongs on our own statute page,
 * which is what the citation grammars resolve it to, and a reference the
 * corpus does not hold belongs in plain text.
 *
 * So the reader renders an absolute hyperlink only to the publisher of the
 * document it is reading. The allowlist is that document's own source hosts,
 * which the API derives from the sources registry
 * (`decisionSourceAttributionUrl` falls back to the adapter manifest's
 * `publicHomeUrl`) and the AST carries in `source.webUrl`. Never a list of
 * vendors to exclude: a blocklist is a list someone has to keep, and every
 * host missing from it renders.
 *
 * A context rather than a prop, and this is the one place in the reader where
 * that is the safer shape. The policy is per document while the renderers that
 * consult it sit five components deep in layout code that has nothing to do
 * with links, and the default is deny: a reader that forgets the provider
 * renders link text without the link, which is a visible degradation rather
 * than a leak. The rule has no exceptions — every absolute URL, `mailto:`
 * included, has to belong to the publisher — because an exception is the shape
 * a source document would be written to fit.
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { sanitizeHref } from "@/lib/sanitize-href";

export type SourceLinkPolicy = {
  /** Hosts of this document's own publisher; empty allows no absolute link. */
  readonly publisherHosts: readonly string[];
};

/** What a reader that names no publisher gets: link text, no links. */
const NO_PUBLISHER: SourceLinkPolicy = { publisherHosts: [] };

const SourceLinkPolicyContext = createContext<SourceLinkPolicy>(NO_PUBLISHER);

const hostOf = (url: string | null | undefined): string | null => {
  const safe = sanitizeHref(url);
  if (safe === undefined || !URL.canParse(safe)) {
    return null;
  }
  const { host } = new URL(safe);
  return host === "" ? null : host.toLowerCase();
};

/**
 * The policy for a document published at these URLs. Every one the reader
 * holds is passed: a publisher serves its catalogue and its permalinks from
 * different hosts often enough that reading only one blocks its own links.
 */
export const sourceLinkPolicyOf = (
  urls: readonly (string | null | undefined)[],
): SourceLinkPolicy => {
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = hostOf(url);
    if (host !== null) {
      hosts.add(host);
    }
  }
  return { publisherHosts: [...hosts].toSorted() };
};

/**
 * Whether a host belongs to the publisher, subdomains included in both
 * directions: a decision served from `vyhledavac.example.gov` links to
 * `example.gov` and the other way round, and both are the same publisher.
 * Suffix comparison rather than a registrable-domain cut, because reading the
 * registrable domain needs a public-suffix list the browser does not carry —
 * and a wrong cut would make `example.co.uk` match every `*.co.uk`.
 */
const isPublisherHost = (host: string, publisherHost: string): boolean =>
  host === publisherHost ||
  host.endsWith(`.${publisherHost}`) ||
  publisherHost.endsWith(`.${host}`);

/**
 * The `href` to render for a link in a source document, or undefined when the
 * reader renders the link's words as text instead.
 *
 * Every URL the reader puts in an `href` goes through here rather than through
 * `sanitizeHref` alone: a protocol check says a URL is safe to follow, not
 * that this document may point a reader at it.
 */
export const readerHref = (
  href: string | null | undefined,
  policy: SourceLinkPolicy,
): string | undefined => {
  const safe = sanitizeHref(href);
  if (safe === undefined) {
    return undefined;
  }
  // In-document and in-app targets: a fragment jump, or a route this reader
  // owns. Neither leaves the corpus, and `sanitizeHref` has already refused a
  // scheme-relative URL wearing a path's leading slash.
  if (safe.startsWith("#") || safe.startsWith("/")) {
    return safe;
  }
  // Everything else answers to the publisher, `mailto:` included: it has no
  // host to belong to one, so a source document's mail link renders as the
  // address it prints. The alternative is a second exception to a rule whose
  // whole value is having none.
  const host = hostOf(safe);
  return host !== null &&
    policy.publisherHosts.some((publisherHost) =>
      isPublisherHost(host, publisherHost),
    )
    ? safe
    : undefined;
};

export const useSourceLinkPolicy = (): SourceLinkPolicy =>
  useContext(SourceLinkPolicyContext);

/**
 * Name the publisher of the document rendered below. `urls` are this
 * document's own source URLs, in whatever spellings the reader holds.
 */
export const SourceLinkPolicyProvider = ({
  children,
  urls,
}: {
  children: ReactNode;
  urls: readonly (string | null | undefined)[];
}) => (
  <SourceLinkPolicyContext.Provider value={sourceLinkPolicyOf(urls)}>
    {children}
  </SourceLinkPolicyContext.Provider>
);
