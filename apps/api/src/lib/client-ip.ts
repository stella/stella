import { panic } from "better-result";
/**
 * Resolves the client IP for a request, refusing to trust
 * `x-forwarded-for` unless the request actually arrived through a trusted
 * proxy.
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
 *
 * An edge that reports the viewer address in a header of its own (for
 * example CloudFront's `CloudFront-Viewer-Address`) is named with
 * `STELLA_CLIENT_ADDRESS_HEADER`. That header is read only from a trusted
 * peer and takes precedence over the `x-forwarded-for` chain.
 */
import { BlockList, isIP, isIPv6 } from "node:net";

import { env } from "@/api/env";
import {
  SIGNUP_RATE_LIMIT_IP_SOURCE,
  type SignupRateLimitIpSource,
} from "@/api/lib/client-ip-config";

/**
 * The header stella sets on every request after resolving the client address,
 * replacing any incoming value, so Better Auth and other readers of request
 * headers see the same address as stella.
 */
export const AUTH_CLIENT_ADDRESS_HEADER = "x-stella-client-address";

export const CLIENT_ADDRESS_SOURCE = {
  edgeHeader: "edge_header",
  forwardedFor: "forwarded_for",
  peer: "peer",
} as const;

export type ClientAddressSource =
  (typeof CLIENT_ADDRESS_SOURCE)[keyof typeof CLIENT_ADDRESS_SOURCE];

export type ClientAddress = { address: string; source: ClientAddressSource };

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

export const isTrustedProxy = (
  address: string,
  trusted: TrustedProxies,
): boolean => {
  const family: "ipv4" | "ipv6" = isIPv6(address) ? "ipv6" : "ipv4";
  try {
    return trusted.blockList.check(address, family);
  } catch {
    return false;
  }
};

let cachedTrustedProxies: TrustedProxies | null = null;

const getTrustedProxies = (): TrustedProxies => {
  cachedTrustedProxies ??= parseTrustedProxies(env.STELLA_TRUSTED_PROXY_CIDRS);
  return cachedTrustedProxies;
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
 * Parses an edge viewer-address header. The value always carries a port
 * (`203.0.113.7:443`, `2001:db8::1:443`, or the bracketed `[2001:db8::1]:443`),
 * so the last colon-separated segment is dropped before validation.
 */
export const parseEdgeClientAddress = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]+)\]:\d{1,5}$/u.exec(trimmed)?.at(1);
  if (bracketed !== undefined) {
    return isIPv6(bracketed) ? bracketed : null;
  }
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) {
    return null;
  }
  const host = trimmed.slice(0, separator);
  const port = trimmed.slice(separator + 1);
  if (!/^\d{1,5}$/u.test(port)) {
    return null;
  }
  return isIP(host) === 0 ? null : host;
};

type ClientAddressOptions = {
  trusted?: TrustedProxies;
  /** Header name carrying the edge's viewer address; null disables it. */
  edgeHeader?: string | null;
};

const addressFromTrustedPeer = (
  request: Request,
  peer: string,
  trusted: TrustedProxies,
  edgeHeader: string | null,
): ClientAddress | null => {
  if (edgeHeader !== null) {
    const address = parseEdgeClientAddress(request.headers.get(edgeHeader));
    if (address !== null) {
      return { address, source: CLIENT_ADDRESS_SOURCE.edgeHeader };
    }
  }
  const forwarded = clientIpFromForwardedFor(
    request.headers.get("x-forwarded-for"),
    peer,
    trusted,
  );
  return forwarded === null
    ? null
    : { address: forwarded, source: CLIENT_ADDRESS_SOURCE.forwardedFor };
};

/**
 * Resolves the client address and where it came from, or `null` if the
 * runtime did not expose a socket peer (e.g. the request was synthesised
 * in-process for tests).
 */
export const resolveClientAddress = (
  request: Request,
  server: ServerLike | null,
  options?: ClientAddressOptions,
): ClientAddress | null => {
  const peer = server?.requestIP(request)?.address ?? null;
  if (!peer) {
    return null;
  }
  const trusted = options?.trusted ?? getTrustedProxies();
  if (!isTrustedProxy(peer, trusted)) {
    return { address: peer, source: CLIENT_ADDRESS_SOURCE.peer };
  }
  const edgeHeader =
    options?.edgeHeader === undefined
      ? (env.STELLA_CLIENT_ADDRESS_HEADER ?? null)
      : options.edgeHeader;
  return (
    addressFromTrustedPeer(request, peer, trusted, edgeHeader) ?? {
      address: peer,
      source: CLIENT_ADDRESS_SOURCE.peer,
    }
  );
};

/**
 * Stamps the resolved address onto the request as
 * {@link AUTH_CLIENT_ADDRESS_HEADER}, replacing any incoming value; without an
 * address the header is removed.
 */
export const stampClientAddressHeader = (
  request: Request,
  clientAddress: ClientAddress | null,
): void => {
  request.headers.delete(AUTH_CLIENT_ADDRESS_HEADER);
  if (clientAddress !== null) {
    request.headers.set(AUTH_CLIENT_ADDRESS_HEADER, clientAddress.address);
  }
};

/** The resolved client IP; see {@link resolveClientAddress}. */
export const resolveClientIp = (
  request: Request,
  server: ServerLike | null,
  options?: ClientAddressOptions,
): string | null =>
  resolveClientAddress(request, server, options)?.address ?? null;

/**
 * Returns a client IP suitable for a shared signup-rate-limit bucket.
 *
 * Direct mode trusts only the kernel-provided socket peer and ignores request
 * headers. Trusted-proxy mode requires the peer to be in the configured proxy
 * set and derives the client from the edge address header, when configured,
 * or its `x-forwarded-for` chain. Keeping the
 * deployment topology explicit prevents both attacker-controlled buckets and
 * one shared bucket for every user behind an unconfigured proxy.
 */
export const resolveSignupRateLimitClientIp = (
  request: Request,
  server: ServerLike | null,
  options?: {
    source?: SignupRateLimitIpSource;
    trusted?: TrustedProxies;
    edgeHeader?: string | null;
  },
): string | null => {
  const peer = server?.requestIP(request)?.address ?? null;
  if (!peer) {
    return null;
  }

  const source = options?.source ?? env.STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE;
  switch (source) {
    case SIGNUP_RATE_LIMIT_IP_SOURCE.direct:
      return peer;
    case SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy:
      break;
    default:
      source satisfies never;
      return panic(`Unhandled source: ${String(source)}`);
  }

  const trusted = options?.trusted ?? getTrustedProxies();
  if (!isTrustedProxy(peer, trusted)) {
    return null;
  }

  const edgeHeader =
    options?.edgeHeader === undefined
      ? (env.STELLA_CLIENT_ADDRESS_HEADER ?? null)
      : options.edgeHeader;
  return (
    addressFromTrustedPeer(request, peer, trusted, edgeHeader)?.address ?? null
  );
};
