import { Result, TaggedError } from "better-result";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as v from "valibot";

const MAX_MCP_URL_LENGTH = 2048;

export class UnsafeMcpUrlError extends TaggedError("UnsafeMcpUrlError")<{
  cause?: unknown;
  message: string;
}>() {}

const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

const isPrivateIpLiteral = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }

  return PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(normalized));
};

export const parseSafeMcpUrl = (
  rawUrl: string,
): Result<URL, UnsafeMcpUrlError> => {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MCP_URL_LENGTH) {
    return Result.err(
      new UnsafeMcpUrlError({ message: "MCP server URL is invalid" }),
    );
  }

  const parsed = v.safeParse(v.pipe(v.string(), v.url()), trimmed);
  if (!parsed.success) {
    return Result.err(
      new UnsafeMcpUrlError({ message: "MCP server URL is invalid" }),
    );
  }

  const url = new URL(trimmed);
  if (url.protocol !== "https:") {
    return Result.err(
      new UnsafeMcpUrlError({ message: "MCP server URL must use HTTPS" }),
    );
  }

  if (
    url.username ||
    url.password ||
    url.hash ||
    isPrivateIpLiteral(url.hostname)
  ) {
    return Result.err(
      new UnsafeMcpUrlError({ message: "MCP server URL is not allowed" }),
    );
  }

  return Result.ok(url);
};

export const validateSafeMcpFetchUrl = async (
  rawUrl: string | URL,
): Promise<Result<URL, UnsafeMcpUrlError>> => {
  const parsed = parseSafeMcpUrl(rawUrl.toString());
  if (Result.isError(parsed)) {
    return parsed;
  }

  const publicAddresses = await resolvePublicAddresses(parsed.value.hostname);
  if (Result.isError(publicAddresses)) {
    return Result.err(publicAddresses.error);
  }

  return Result.ok(parsed.value);
};

export const mcpWellKnownProtectedResourceUrls = (mcpUrl: URL): URL[] => {
  const root = new URL("/.well-known/oauth-protected-resource", mcpUrl.origin);
  const pathScoped = new URL(
    `/.well-known/oauth-protected-resource${mcpUrl.pathname}`,
    mcpUrl.origin,
  );

  return mcpUrl.pathname === "/" ? [root] : [pathScoped, root];
};

export const authorizationServerMetadataUrls = (
  authorizationServerUrl: URL,
): URL[] => {
  if (authorizationServerUrl.pathname === "/") {
    return [
      new URL(
        "/.well-known/oauth-authorization-server",
        authorizationServerUrl.origin,
      ),
      new URL(
        "/.well-known/openid-configuration",
        authorizationServerUrl.origin,
      ),
    ];
  }

  const path = authorizationServerUrl.pathname.replace(/\/$/, "");

  return [
    new URL(
      `/.well-known/oauth-authorization-server${path}`,
      authorizationServerUrl.origin,
    ),
    new URL(
      `/.well-known/openid-configuration${path}`,
      authorizationServerUrl.origin,
    ),
    new URL(`${path}/.well-known/openid-configuration`, authorizationServerUrl),
  ];
};

const resolvePublicAddresses = async (
  hostname: string,
): Promise<Result<void, UnsafeMcpUrlError>> => {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return isPrivateAddress(hostname)
      ? Result.err(
          new UnsafeMcpUrlError({ message: "MCP server URL is not allowed" }),
        )
      : Result.ok(undefined);
  }

  const addresses = await Result.tryPromise({
    try: async () => await lookup(hostname, { all: true }),
    catch: (cause) =>
      new UnsafeMcpUrlError({
        message: "MCP server host could not be resolved",
        cause,
      }),
  });

  if (Result.isError(addresses)) {
    return Result.err(addresses.error);
  }

  if (
    addresses.value.length === 0 ||
    addresses.value.some(({ address }) => isPrivateAddress(address))
  ) {
    return Result.err(
      new UnsafeMcpUrlError({ message: "MCP server URL is not allowed" }),
    );
  }

  return Result.ok(undefined);
};

const isPrivateAddress = (address: string): boolean => {
  if (address.startsWith("::ffff:")) {
    return isPrivateAddress(address.slice("::ffff:".length));
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b] = octets;
  if (a === undefined || b === undefined) {
    return true;
  }

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};
