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
 * peer and takes precedence over the `x-forwarded-for` chain. CloudFront
 * requires a matching origin verification value because its origin is publicly
 * reachable. Custom proxy headers may leave origin verification unconfigured.
 *
 * A further edge may supply the address in {@link FRONTEND_ADDRESS_HEADER},
 * accepted only with a matching {@link FRONTEND_VERIFY_HEADER}. From a
 * trusted peer the sources are tried in order: that header when its verify
 * value matches, the edge header above when the origin value matches, then
 * the forwarded chain.
 */
import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";

import { sha256Bytes as hashSha256Bytes } from "@stll/sha256/bun";

import { env } from "@/api/env";
import {
  AUTH_CLIENT_ADDRESS_HEADER,
  FRONTEND_ADDRESS_HEADER,
  FRONTEND_VERIFY_HEADER,
  ORIGIN_VERIFY_HEADER,
  SIGNUP_RATE_LIMIT_IP_SOURCE,
  type SignupRateLimitIpSource,
} from "@/api/lib/client-ip-config";
import { logger } from "@/api/lib/observability/logger";

/**
 * The header stella sets on every request after resolving the client address,
 * replacing any incoming value, so Better Auth and other readers of request
 * headers see the same address as stella.
 */
export { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip-config";

/**
 * The header the edge adds to prove a request came through it. When
 * `STELLA_ORIGIN_VERIFY_SECRET` is set, the edge address header is read only
 * from requests that carry one of its values here.
 */
export { ORIGIN_VERIFY_HEADER } from "@/api/lib/client-ip-config";

/**
 * The frontend edge's headers. {@link FRONTEND_ADDRESS_HEADER} is read only
 * from requests whose {@link FRONTEND_VERIFY_HEADER} carries one of the
 * `STELLA_FRONTEND_VERIFY_SECRET` values; without values it is never read.
 */
export {
  FRONTEND_ADDRESS_HEADER,
  FRONTEND_VERIFY_HEADER,
} from "@/api/lib/client-ip-config";

const EDGE_ADDRESS_FORMAT = {
  withPort: "with-port",
  bare: "bare",
} as const;

export type EdgeAddressFormat =
  (typeof EDGE_ADDRESS_FORMAT)[keyof typeof EDGE_ADDRESS_FORMAT];

export const CLIENT_ADDRESS_SOURCE = {
  frontendHeader: "frontend_header",
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

  // A malformed entry is skipped rather than crashing boot. The skipped
  // entries are logged together: a peer they were meant to cover is
  // untrusted, so its requests record the socket peer instead of the
  // forwarded client.
  const rejected: string[] = [];
  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    const slashIndex = entry.indexOf("/");
    const ip = (slashIndex === -1 ? entry : entry.slice(0, slashIndex)).trim();
    const prefixText =
      slashIndex === -1 ? null : entry.slice(slashIndex + 1).trim();
    if (ip.length === 0 || prefixText === "") {
      rejected.push(entry);
      continue;
    }
    const ipVersion = isIP(ip);
    if (ipVersion === 0) {
      rejected.push(entry);
      continue;
    }
    const family: "ipv4" | "ipv6" = ipVersion === 6 ? "ipv6" : "ipv4";
    const defaultPrefix = family === "ipv6" ? 128 : 32;
    const prefix = prefixText === null ? defaultPrefix : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > defaultPrefix) {
      rejected.push(entry);
      continue;
    }
    try {
      blockList.addSubnet(ip, prefix, family);
    } catch {
      rejected.push(entry);
    }
  }
  if (rejected.length > 0) {
    logger.warn("client_ip.trusted_proxy_entries_rejected", {
      "trustedProxy.rejectedEntries": rejected.join(","),
    });
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
 * Parses an edge viewer-address header. In the `with-port` format the value
 * carries a port (`203.0.113.7:443`, `2001:db8::1:443`, or the bracketed
 * `[2001:db8::1]:443`), whose last colon-separated segment is dropped; an
 * unbracketed IPv6 value is ambiguous otherwise, so the format is configured,
 * never guessed. The `bare` format carries the address alone.
 */
export const parseEdgeClientAddress = (
  value: string | null,
  format: EdgeAddressFormat = EDGE_ADDRESS_FORMAT.withPort,
): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (format === EDGE_ADDRESS_FORMAT.bare) {
    return isIP(trimmed) === 0 ? null : trimmed;
  }
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
  /**
   * Configured origin values must match. CloudFront requires values; custom
   * proxy headers may rely on the trusted peer alone.
   */
  originSecrets?: readonly string[];
  /** How the edge header spells the address; defaults to the configured one. */
  edgeAddressFormat?: EdgeAddressFormat;
  /**
   * Accepted {@link FRONTEND_VERIFY_HEADER} values;
   * {@link FRONTEND_ADDRESS_HEADER} is read only from requests carrying one of
   * them, so an empty list disables it.
   */
  frontendSecrets?: readonly string[];
};

/** Whether `header` carries one of `secrets`; never with no secrets. */
const carriesSecret = (
  request: Request,
  header: string,
  secrets: readonly string[],
): boolean => {
  const presented = request.headers.get(header);
  if (presented === null || secrets.length === 0) {
    return false;
  }
  const presentedDigest = hashSha256Bytes(presented);
  // Every value is compared so the time taken does not reveal which matched.
  return secrets
    .map((secret) => timingSafeEqual(presentedDigest, hashSha256Bytes(secret)))
    .includes(true);
};

const parseSecretList = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const CLOUDFRONT_VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";

const requiresOriginProof = (header: string | null | undefined): boolean =>
  header?.trim().toLowerCase() === CLOUDFRONT_VIEWER_ADDRESS_HEADER;

type ClientAddressConfigurationOptions = {
  edgeHeader?: string | undefined;
  originVerifySecret?: string | undefined;
};

/** Warn when the CloudFront viewer header cannot be authenticated. */
export const clientAddressConfigurationWarning = ({
  edgeHeader,
  originVerifySecret,
}: ClientAddressConfigurationOptions):
  | "client_ip.viewer_address_unconfigured"
  | null =>
  requiresOriginProof(edgeHeader) &&
  parseSecretList(originVerifySecret).length === 0
    ? "client_ip.viewer_address_unconfigured"
    : null;

let cachedOriginSecrets: readonly string[] | null = null;

const getOriginSecrets = (): readonly string[] => {
  cachedOriginSecrets ??= parseSecretList(env.STELLA_ORIGIN_VERIFY_SECRET);
  return cachedOriginSecrets;
};

let cachedFrontendSecrets: readonly string[] | null = null;

const getFrontendSecrets = (): readonly string[] => {
  cachedFrontendSecrets ??= parseSecretList(env.STELLA_FRONTEND_VERIFY_SECRET);
  return cachedFrontendSecrets;
};

type TrustedPeerInput = {
  request: Request;
  peer: string;
  trusted: TrustedProxies;
  edgeHeader: string | null;
  originSecrets: readonly string[];
  edgeAddressFormat: EdgeAddressFormat;
  frontendSecrets: readonly string[];
};

const addressFromTrustedPeer = ({
  request,
  peer,
  trusted,
  edgeHeader,
  originSecrets,
  edgeAddressFormat,
  frontendSecrets,
}: TrustedPeerInput): ClientAddress | null => {
  // The frontend edge writes the bare address; any other spelling falls
  // through.
  if (carriesSecret(request, FRONTEND_VERIFY_HEADER, frontendSecrets)) {
    const address = parseEdgeClientAddress(
      request.headers.get(FRONTEND_ADDRESS_HEADER),
      EDGE_ADDRESS_FORMAT.bare,
    );
    if (address !== null) {
      return { address, source: CLIENT_ADDRESS_SOURCE.frontendHeader };
    }
  }
  if (
    edgeHeader !== null &&
    ((originSecrets.length === 0 && !requiresOriginProof(edgeHeader)) ||
      carriesSecret(request, ORIGIN_VERIFY_HEADER, originSecrets))
  ) {
    const address = parseEdgeClientAddress(
      request.headers.get(edgeHeader),
      edgeAddressFormat,
    );
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
  if (options === undefined && resolvedAddresses.has(request)) {
    return resolvedAddresses.get(request) ?? null;
  }
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
    addressFromTrustedPeer({
      request,
      peer,
      trusted,
      edgeHeader,
      originSecrets: options?.originSecrets ?? getOriginSecrets(),
      edgeAddressFormat:
        options?.edgeAddressFormat ?? env.STELLA_CLIENT_ADDRESS_FORMAT,
      frontendSecrets: options?.frontendSecrets ?? getFrontendSecrets(),
    }) ?? {
      address: peer,
      source: CLIENT_ADDRESS_SOURCE.peer,
    }
  );
};

// The address each request resolved to when it arrived, before
// {@link sealEdgeHeaders} removed the headers it was read from.
const resolvedAddresses = new WeakMap<Request, ClientAddress | null>();

/**
 * Records the request's resolved address for later readers and removes the
 * edge headers, so handlers and logs never see the origin secret and later
 * lookups cannot re-read a header.
 */
export const sealEdgeHeaders = (
  request: Request,
  clientAddress: ClientAddress | null,
): void => {
  resolvedAddresses.set(request, clientAddress);
  for (const header of [
    ORIGIN_VERIFY_HEADER,
    FRONTEND_VERIFY_HEADER,
    FRONTEND_ADDRESS_HEADER,
    env.STELLA_CLIENT_ADDRESS_HEADER,
  ]) {
    if (header !== undefined) {
      request.headers.delete(header);
    }
  }
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
 * set and derives the client from the edge address headers, when configured
 * and verified, or its `x-forwarded-for` chain. Keeping the
 * deployment topology explicit prevents both attacker-controlled buckets and
 * one shared bucket for every user behind an unconfigured proxy.
 */
export const resolveSignupRateLimitClientIp = (
  request: Request,
  server: ServerLike | null,
  options?: ClientAddressOptions & { source?: SignupRateLimitIpSource },
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
    addressFromTrustedPeer({
      request,
      peer,
      trusted,
      edgeHeader,
      originSecrets: options?.originSecrets ?? getOriginSecrets(),
      edgeAddressFormat:
        options?.edgeAddressFormat ?? env.STELLA_CLIENT_ADDRESS_FORMAT,
      frontendSecrets: options?.frontendSecrets ?? getFrontendSecrets(),
    })?.address ?? null
  );
};

const IPV6_RATE_LIMIT_PREFIX_LENGTH = 64;

// A valid IPv6 spelling may end in a dotted IPv4 address; rewrite it as the
// two hex groups it stands for.
const expandEmbeddedIPv4 = (address: string): string => {
  const lastGroupStart = address.lastIndexOf(":") + 1;
  const lastGroup = address.slice(lastGroupStart);
  if (!lastGroup.includes(".")) {
    return address;
  }
  const value = lastGroup
    .split(".")
    .reduce((n, octet) => n * 256 + Number(octet), 0);
  return `${address.slice(0, lastGroupStart)}${Math.floor(value / 65_536).toString(16)}:${(value % 65_536).toString(16)}`;
};

export const normalizeRateLimitClientAddress = (identity: string): string => {
  if (isIPv4(identity) || !isIPv6(identity)) {
    return identity;
  }
  const zoneStart = identity.indexOf("%");
  const address = expandEmbeddedIPv4(
    zoneStart === -1 ? identity : identity.slice(0, zoneStart),
  );
  const [left = "", right = ""] = address.split("::");
  const head = left === "" ? [] : left.split(":");
  const tail = right === "" ? [] : right.split(":");
  const groups = address.includes("::")
    ? [
        ...head,
        ...Array.from({ length: 8 - head.length - tail.length }, () => "0"),
        ...tail,
      ]
    : head;
  const values = groups.map((group) => Number.parseInt(group, 16));
  if (
    values.slice(0, 5).every((group) => group === 0) &&
    values.at(5) === 0xff_ff
  ) {
    const ipv4 = values
      .slice(6)
      .reduce((value, group) => value * 65_536 + group, 0);
    return [24, 16, 8, 0]
      .map((shift) => Math.floor(ipv4 / 2 ** shift) % 256)
      .join(".");
  }
  const network = values.slice(0, IPV6_RATE_LIMIT_PREFIX_LENGTH / 16);
  // The /64 mask supplies four trailing zero groups, so its trailing run is
  // always the longest; no earlier run can contain more than three zeros.
  while (network.at(-1) === 0) {
    network.pop();
  }
  return `${network.map((group) => group.toString(16)).join(":")}::`;
};

export type RateLimitClientAddressOptions = {
  request: Request;
  server: ServerLike | null;
  clientAddressOptions?: ClientAddressOptions;
};

export const resolveRateLimitClientAddress = ({
  request,
  server,
  clientAddressOptions,
}: RateLimitClientAddressOptions): string | null => {
  const client = resolveClientAddress(request, server, clientAddressOptions);
  return client === null
    ? null
    : normalizeRateLimitClientAddress(client.address);
};
