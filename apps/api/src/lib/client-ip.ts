/**
 * Resolves the client IP for a request, refusing to trust
 * `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` headers unless
 * the request actually arrived through a trusted proxy.
 *
 * The TCP socket's peer address is the only thing we can rely on by
 * default: a header value can be set to anything by the caller, but
 * the socket peer is set by the kernel from the actual handshake.
 * We therefore only honour forwarded-IP headers when that peer is in
 * the configured trusted-proxy set; otherwise we record the peer
 * address itself.
 *
 * Operators populate the trusted set via `STELLA_TRUSTED_PROXY_CIDRS`
 * (comma-separated CIDRs covering the load balancers and CDNs in
 * front of the API). When the variable is unset, no proxy is
 * trusted: forwarded headers are ignored.
 */
import { BlockList, isIP, isIPv6 } from "node:net";

import { env } from "@/api/env";

type ServerLike = {
  requestIP: (request: Request) => { address: string } | null;
};

export type TrustedProxies = { blockList: BlockList };

export const parseTrustedProxies = (
  value: string | null | undefined,
): TrustedProxies => {
  const blockList = new BlockList();
  if (!value) {
    return { blockList };
  }

  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    const slashIndex = entry.indexOf("/");
    const ip = (slashIndex === -1 ? entry : entry.slice(0, slashIndex)).trim();
    const prefixText =
      slashIndex === -1 ? null : entry.slice(slashIndex + 1).trim();
    if (ip.length === 0 || prefixText === "") {
      continue;
    }
    const ipVersion = isIP(ip);
    if (ipVersion === 0) {
      continue;
    }
    const family: "ipv4" | "ipv6" = ipVersion === 6 ? "ipv6" : "ipv4";
    const defaultPrefix = family === "ipv6" ? 128 : 32;
    const prefix = prefixText === null ? defaultPrefix : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > defaultPrefix) {
      continue;
    }
    try {
      blockList.addSubnet(ip, prefix, family);
    } catch {
      // Malformed entry — skip rather than crash boot. Operators get
      // visibility via the audit log: a misconfigured trusted set
      // simply records the socket peer instead of forwarded headers.
    }
  }

  return { blockList };
};

const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * Strips the `::ffff:` prefix from an IPv4-mapped IPv6 address and
 * returns the embedded IPv4. Bun's dual-stack socket reports IPv4
 * connections in this form (e.g. `::ffff:203.0.113.7`); operators
 * write proxy CIDRs as plain IPv4, so we fall back to matching the
 * embedded address when the IPv6 form does not match.
 */
const ipv4FromMappedIpv6 = (address: string): string | null => {
  if (!address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    return null;
  }
  const candidate = address.slice(IPV4_MAPPED_PREFIX.length);
  return isIP(candidate) === 4 ? candidate : null;
};

export const isTrustedProxy = (
  address: string,
  trusted: TrustedProxies,
): boolean => {
  const family: "ipv4" | "ipv6" = isIPv6(address) ? "ipv6" : "ipv4";
  try {
    if (trusted.blockList.check(address, family)) {
      return true;
    }
  } catch {
    // Fall through to the mapped-v4 check below.
  }
  const mappedV4 = ipv4FromMappedIpv6(address);
  if (mappedV4 !== null) {
    try {
      return trusted.blockList.check(mappedV4, "ipv4");
    } catch {
      return false;
    }
  }
  return false;
};

let cachedTrustedProxies: TrustedProxies | null = null;

const getTrustedProxies = (): TrustedProxies => {
  cachedTrustedProxies ??= parseTrustedProxies(env.STELLA_TRUSTED_PROXY_CIDRS);
  return cachedTrustedProxies;
};

const nullableIpHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim();
  if (!value || isIP(value) === 0) {
    return null;
  }
  return value;
};

const clientIpFromForwardedFor = (
  forwardedFor: string | null,
  peer: string,
  trusted: TrustedProxies,
): string | null => {
  if (!forwardedFor) {
    return null;
  }
  const ips = forwardedFor
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (ips.length === 0) {
    return null;
  }

  let clientIp = peer;
  for (let index = ips.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxy(clientIp, trusted)) {
      break;
    }

    const nextIp = ips.at(index);
    if (!nextIp || isIP(nextIp) === 0) {
      return null;
    }
    clientIp = nextIp;
  }

  return clientIp === peer ? null : clientIp;
};

/**
 * Returns the resolved client IP for an incoming request, or `null`
 * if the runtime did not expose a socket peer (e.g. the request was
 * synthesised in-process for tests).
 */
export const resolveClientIp = (
  request: Request,
  server: ServerLike | null,
  options?: { trusted?: TrustedProxies },
): string | null => {
  const peer = server?.requestIP(request)?.address ?? null;
  if (!peer) {
    return null;
  }
  const trusted = options?.trusted ?? getTrustedProxies();
  if (!isTrustedProxy(peer, trusted)) {
    return peer;
  }
  const cf = nullableIpHeader(request.headers, "cf-connecting-ip");
  if (cf) {
    return cf;
  }
  const real = nullableIpHeader(request.headers, "x-real-ip");
  if (real) {
    return real;
  }
  const xff = clientIpFromForwardedFor(
    request.headers.get("x-forwarded-for"),
    peer,
    trusted,
  );
  if (xff) {
    return xff;
  }
  return peer;
};
