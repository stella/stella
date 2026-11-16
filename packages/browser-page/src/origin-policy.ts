const LOCAL_HOSTNAME_SUFFIXES = [".local", ".localhost", ".internal"] as const;

const isPrivateIpv4 = (octets: readonly number[]): boolean => {
  const [a, b] = octets;
  if (a === undefined || b === undefined) {
    return true;
  }
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
};

/**
 * A hostname the controlled tab may be pointed at: a named public host. Loopback,
 * private and link-local IPv4 ranges, every IPv6 literal, single-label names and
 * local suffixes are refused. The check sees the name only: a public name that
 * resolves to a private address passes.
 */
export const isPublicHostname = (rawHostname: string): boolean => {
  const hostname = rawHostname.toLowerCase().replace(/\.$/u, "");
  if (hostname.length === 0 || hostname.startsWith("[")) {
    return false;
  }
  if (
    hostname === "localhost" ||
    LOCAL_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return false;
  }
  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }
  const octets = labels.map(Number);
  const isIpv4Literal =
    labels.length === 4 &&
    octets.every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        /^\d{1,3}$/u.test(labels[index] ?? ""),
    );
  return !isIpv4Literal || !isPrivateIpv4(octets);
};

/** A hostname without the DNS root's trailing dot, lower case. */
const withoutRootDot = (hostname: string): string =>
  hostname.toLowerCase().replace(/\.$/u, "");

/** What a host counts as stella: its pages stay out of reach of every command. */
type StellaOrigins = {
  /** Hosts of every stella origin, trusted by this build or not. */
  hostnames: readonly string[];
  /** The stella origin `rawUrl` is on, or null. */
  originFromUrl: (rawUrl: string) => string | null;
};

/**
 * The origin policy of one host, given which origins are stella's: the
 * extension's build configuration names them, the holder its account's.
 */
export const createOriginPolicy = ({
  hostnames,
  originFromUrl,
}: StellaOrigins) => {
  const stellaHosts: ReadonlySet<string> = new Set(
    hostnames.map(withoutRootDot),
  );
  /**
   * Parses a URL the controlled tab may open or act on: HTTPS, no embedded
   * credentials, a public host, and never stella itself, whose signed-in
   * session must stay out of reach of page-driven actions. A name with the
   * DNS root's trailing dot is the same host, so stella is recognised
   * either way.
   */
  const parseControllableUrl = (rawUrl: string): URL | null => {
    const url = URL.parse(rawUrl);
    if (
      url?.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !isPublicHostname(url.hostname)
    ) {
      return null;
    }
    const named = new URL(url.href);
    named.hostname = withoutRootDot(url.hostname);
    if (stellaHosts.has(named.hostname) || originFromUrl(named.href) !== null) {
      return null;
    }
    return url;
  };

  /**
   * Whether a frame of the controlled tab may be read or operated. The origin
   * of its document must pass the policy, so `about:blank`, `srcdoc` and blob
   * frames count as the page that created them and opaque origins never pass;
   * the top frame's own URL must pass as well.
   */
  const isControllableFrame = ({
    isTopFrame,
    origin,
    url,
  }: {
    isTopFrame: boolean;
    origin: string;
    url: string;
  }): boolean =>
    parseControllableUrl(origin) !== null &&
    (!isTopFrame || parseControllableUrl(url) !== null);

  return { isControllableFrame, parseControllableUrl };
};

export type OriginPolicy = ReturnType<typeof createOriginPolicy>;

const HOST_END = String.raw`\.?(?::\d+)?(?:[/?#]|$)`;
const OCTET = String.raw`\d{1,3}`;
/** HTTPS and secure WebSockets; plain `http:` and `ws:` are blocked outright. */
const SECURE_SCHEME = String.raw`^(?:https|wss)://`;

/**
 * The URLs `parseControllableUrl` refuses for their authority, as RE2
 * patterns for declarativeNetRequest rules; each stays well under Chrome's
 * 2 KB compiled-regex limit. They cover secure WebSocket URLs as well, since
 * the rules hold for every request a controlled tab makes. Chrome
 * canonicalizes IPv4 hosts to dotted decimal before matching.
 */
export const NON_PUBLIC_SECURE_URL_PATTERNS = [
  // Embedded credentials, which also covers any host behind them.
  String.raw`${SECURE_SCHEME}[^/?#]*@`,
  // Every IPv6 literal.
  String.raw`${SECURE_SCHEME}\[`,
  // Single-label names; this also covers bare `local` and `internal`.
  String.raw`${SECURE_SCHEME}[^./?#:]+${HOST_END}`,
  String.raw`${SECURE_SCHEME}(?:[^/?#:]*\.)?(?:localhost|local|internal)${HOST_END}`,
  String.raw`${SECURE_SCHEME}(?:(?:0|10|127|22[4-9]|2[34]\d|25[0-5])\.${OCTET}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168|198\.1[89])\.${OCTET}\.${OCTET}${HOST_END}`,
];
