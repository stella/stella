import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const normalizeMcpConnectorUrl = (
  rawUrl: string,
): Result<string, HandlerError<400>> =>
  Result.try({
    try: () => normalizeUrl(rawUrl),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "MCP server URL is invalid",
        cause,
      }),
  });

export const mcpConnectorUrlIdentity = (rawUrl: string): string =>
  Result.try(() => normalizeUrl(rawUrl)).unwrapOr(rawUrl.trim());

export const mcpConnectorUrlVariants = (normalizedUrl: string): string[] => {
  const variants = new Set([normalizedUrl]);
  const url = new URL(normalizedUrl);
  if (url.pathname === "/" && url.search.length === 0) {
    variants.add(`${url.origin}/`);
    variants.add(url.origin);
  } else if (url.search.length === 0) {
    variants.add(`${normalizedUrl}/`);
  }
  return Array.from(variants);
};

// MCP servers speak HTTP(S) only. Accept a bare host (e.g.
// "mcp.example.com") and default it to https so users don't have to type
// the scheme; an explicit http:// / https:// prefix is preserved.
const ensureHttpScheme = (rawUrl: string): string =>
  /^https?:\/\//iu.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

const normalizeUrl = (rawUrl: string): string => {
  const url = new URL(ensureHttpScheme(rawUrl.trim()));
  url.hash = "";
  while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  const normalized = url.toString();
  return url.pathname === "/" && url.search.length === 0
    ? normalized.replace(/\/$/u, "")
    : normalized;
};
