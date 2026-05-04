/**
 * Validate a user-supplied AI provider base URL against SSRF.
 *
 * Used for the BYOK `openai_compatible` provider, where the
 * baseURL is org-controlled. The validator rejects:
 * - non-HTTPS schemes
 * - URLs with embedded credentials
 * - hostnames that are IP literals in private, loopback,
 *   link-local, multicast, or reserved ranges (IPv4 + IPv6)
 * - reserved local hostnames (`localhost`, `*.local`,
 *   `*.internal`, etc.)
 *
 * This is a literal-only check: it does not resolve DNS,
 * so a public hostname resolving to an internal IP is not
 * caught here. Bind/egress controls are the second layer.
 */

export type SafeBaseURLResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".home",
  ".lan",
];

const BLOCKED_HOST_EXACT = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

export const validateSafeBaseURL = (raw: string): SafeBaseURLResult => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Base URL is not a valid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Base URL must use HTTPS" };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, error: "Base URL must not contain credentials" };
  }

  const rawHost = parsed.hostname.toLowerCase();
  if (rawHost === "") {
    return { ok: false, error: "Base URL must include a hostname" };
  }

  // URL.hostname keeps brackets around IPv6 literals; strip them
  // so the IPv6 checks below see a bare address. For DNS names,
  // also strip a trailing dot (e.g. `localhost.`) which URL parsing
  // preserves but resolves identically to the bare name — without
  // this it bypasses both the exact and suffix denylists.
  const isIPv6Literal = rawHost.startsWith("[") && rawHost.endsWith("]");
  const host = isIPv6Literal ? rawHost.slice(1, -1) : trimTrailingDots(rawHost);

  if (BLOCKED_HOST_EXACT.has(host)) {
    return { ok: false, error: "Base URL host is not allowed" };
  }

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, error: "Base URL host is not allowed" };
    }
  }

  if (isIPv6Literal || host.includes(":")) {
    if (isBlockedIPv6(host)) {
      return { ok: false, error: "Base URL host is not allowed" };
    }
    return { ok: true, url: parsed.toString() };
  }

  const ipv4 = parseIPv4(host);
  if (ipv4 !== undefined) {
    if (isBlockedIPv4(ipv4)) {
      return { ok: false, error: "Base URL host is not allowed" };
    }
    return { ok: true, url: parsed.toString() };
  }

  return { ok: true, url: parsed.toString() };
};

const trimTrailingDots = (s: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === ".") {
    end -= 1;
  }
  return end === s.length ? s : s.slice(0, end);
};

type IPv4 = readonly [number, number, number, number];

const parseOctet = (s: string): number | undefined => {
  if (s === "" || !/^\d+$/.test(s)) {
    return undefined;
  }
  const n = Number(s);
  if (n < 0 || n > 255) {
    return undefined;
  }
  return n;
};

const parseIPv4 = (host: string): IPv4 | undefined => {
  const [s0, s1, s2, s3, ...rest] = host.split(".");
  if (
    rest.length > 0 ||
    s0 === undefined ||
    s1 === undefined ||
    s2 === undefined ||
    s3 === undefined
  ) {
    return undefined;
  }
  const o0 = parseOctet(s0);
  const o1 = parseOctet(s1);
  const o2 = parseOctet(s2);
  const o3 = parseOctet(s3);
  if (
    o0 === undefined ||
    o1 === undefined ||
    o2 === undefined ||
    o3 === undefined
  ) {
    return undefined;
  }
  return [o0, o1, o2, o3];
};

const isBlockedIPv4 = (ip: IPv4): boolean => {
  const [a, b] = ip;
  if (a === 0) {
    return true;
  } // 0.0.0.0/8
  if (a === 10) {
    return true;
  } // 10.0.0.0/8
  if (a === 127) {
    return true;
  } // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) {
    return true;
  } // link-local incl. AWS metadata
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  } // 172.16.0.0/12
  if (a === 192 && b === 168) {
    return true;
  } // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  } // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && ip[2] === 0) {
    return true;
  } // 192.0.0.0/24
  if (a === 192 && b === 0 && ip[2] === 2) {
    return true;
  } // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  } // 198.18.0.0/15
  if (a === 198 && b === 51 && ip[2] === 100) {
    return true;
  } // TEST-NET-2
  if (a === 203 && b === 0 && ip[2] === 113) {
    return true;
  } // TEST-NET-3
  if (a >= 224 && a <= 239) {
    return true;
  } // 224.0.0.0/4 multicast
  if (a >= 240) {
    return true;
  } // 240.0.0.0/4 reserved + 255.255.255.255
  return false;
};

const isBlockedIPv6 = (host: string): boolean => {
  const compressed = host.toLowerCase();

  // Unspecified and loopback.
  if (compressed === "::" || compressed === "::1") {
    return true;
  }

  // The first hextet of fe80::/10, fc00::/7, and ff00::/8 is always
  // ≥ 0x1000, so URL normalization keeps all four hex digits — no
  // leading-zero forms like `fe8::` to worry about, and matching
  // shorter prefixes here would over-block legitimate addresses.

  // Link-local fe80::/10 — first hextet 0xfe80–0xfebf.
  if (/^fe[89ab][0-9a-f]:/.test(compressed)) {
    return true;
  }

  // Unique local fc00::/7 — first hextet 0xfc00–0xfdff.
  if (/^f[cd][0-9a-f]{2}:/.test(compressed)) {
    return true;
  }

  // Multicast ff00::/8 — first hextet 0xff00–0xffff.
  if (/^ff[0-9a-f]{2}:/.test(compressed)) {
    return true;
  }

  // Documentation 2001:db8::/32, benchmarking 2001:2::/48,
  // discard-only 100::/64 — match the IPv4 reserved-range posture.
  if (
    compressed.startsWith("2001:db8:") ||
    compressed.startsWith("2001:2:") ||
    compressed.startsWith("100:")
  ) {
    return true;
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compat (::a.b.c.d).
  // Apply IPv4 rules to the embedded address.
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(compressed);
  const dottedIp = dotted?.[1];
  if (dottedIp !== undefined) {
    const ipv4 = parseIPv4(dottedIp);
    if (ipv4 && isBlockedIPv4(ipv4)) {
      return true;
    }
  }

  // The URL parser normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1.
  // Decode the trailing two hextets back to four IPv4 octets.
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed);
  const hexHigh = hex?.[1];
  const hexLow = hex?.[2];
  if (hexHigh !== undefined && hexLow !== undefined) {
    const high = Number.parseInt(hexHigh, 16);
    const low = Number.parseInt(hexLow, 16);
    const ipv4: IPv4 = [
      Math.trunc(high / 256),
      high % 256,
      Math.trunc(low / 256),
      low % 256,
    ];
    if (isBlockedIPv4(ipv4)) {
      return true;
    }
  }

  return false;
};
