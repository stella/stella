/**
 * The hosts a trusted upstream protocol is allowed to name. Exported so a
 * source adapter can declare its publisher's origins as data and a framework
 * — rather than each adapter — applies the check to every URL it returns.
 */
export type OutboundHostPolicy =
  | { type: "exact-origin"; origins: readonly string[] }
  | { type: "https-host-suffix"; suffixes: readonly string[] };

type RestrictOutboundUrlOptions = {
  hostPolicy: OutboundHostPolicy;
  pathPrefixes?: readonly string[] | undefined;
  rawUrl: string;
};

const MAX_OUTBOUND_URL_LENGTH = 2048;

const pathMatchesPrefix = (pathname: string, prefix: string): boolean =>
  prefix.endsWith("/")
    ? pathname.startsWith(prefix)
    : pathname === prefix || pathname.startsWith(`${prefix}/`);

const trimDots = (value: string): string => {
  let start = 0;
  while (value[start] === ".") {
    start++;
  }
  let end = value.length;
  while (end > start && value[end - 1] === ".") {
    end--;
  }
  return value.slice(start, end);
};

/**
 * Restrict a URL supplied by a trusted upstream protocol to that protocol's
 * declared public origin or HTTPS domain family.
 *
 * This boundary is for provider-issued links whose host is part of the
 * provider contract. Arbitrary user-selected internet targets must instead go
 * through safeOutboundFetchBytes/safeOutboundFetchStream so DNS is validated
 * and pinned before the connection is opened.
 */
export const restrictOutboundUrl = ({
  hostPolicy,
  pathPrefixes,
  rawUrl,
}: RestrictOutboundUrlOptions): URL | null => {
  if (rawUrl.length === 0 || rawUrl.length > MAX_OUTBOUND_URL_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return null;
  }

  if (hostPolicy.type === "exact-origin") {
    if (!hostPolicy.origins.includes(url.origin)) {
      return null;
    }
  } else {
    if (url.protocol !== "https:" || url.port !== "") {
      return null;
    }
    const hostname = trimDots(url.hostname.toLowerCase());
    const allowed = hostPolicy.suffixes.some((candidate) => {
      const suffix = trimDots(candidate.toLowerCase());
      return (
        suffix !== "" &&
        (hostname === suffix || hostname.endsWith(`.${suffix}`))
      );
    });
    if (!allowed) {
      return null;
    }
  }

  if (
    pathPrefixes !== undefined &&
    (url.pathname.includes("%") ||
      !pathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix)))
  ) {
    return null;
  }

  return url;
};
