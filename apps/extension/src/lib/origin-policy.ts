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
 * local suffixes are refused so the user's cookies never reach an intranet,
 * router, dev server or cloud metadata endpoint through an approved action.
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

/** Parses a URL the controlled tab may open or act on: HTTPS, no embedded credentials, public host. */
export const parseControllableUrl = (rawUrl: string): URL | null => {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !isPublicHostname(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};
