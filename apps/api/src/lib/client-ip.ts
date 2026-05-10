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
import { BlockList, isIPv6 } from "node:net";

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
    const ip = slashIndex === -1 ? entry : entry.slice(0, slashIndex);
    const prefixText = slashIndex === -1 ? null : entry.slice(slashIndex + 1);
    const family: "ipv4" | "ipv6" = isIPv6(ip) ? "ipv6" : "ipv4";
    const defaultPrefix = family === "ipv6" ? 128 : 32;
    const prefix = prefixText === null ? defaultPrefix : Number(prefixText);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > defaultPrefix) {
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

const firstForwardedIp = (forwardedFor: string | null): string | null => {
  if (!forwardedFor) {
    return null;
  }
  const first = forwardedFor.split(",").at(0)?.trim();
  return first && first.length > 0 ? first : null;
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
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return cf;
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) {
    return real;
  }
  const xff = firstForwardedIp(request.headers.get("x-forwarded-for"));
  if (xff) {
    return xff;
  }
  return peer;
};
