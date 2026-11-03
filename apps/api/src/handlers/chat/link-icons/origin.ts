import { Result, TaggedError } from "better-result";
import { getDomain } from "tldts";

import { Temporal } from "@stll/time";

import { isValidLinkIconImage } from "@/api/handlers/chat/link-icons/image";
import type { LinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { logger } from "@/api/lib/observability/logger";
import { parseSafeOutboundUrl } from "@/api/lib/safe-outbound-fetch";

const LINK_ICON_MAX_BYTES = 64 * 1024;
const ORIGIN_DEADLINE_MS = 3000;
const MAX_REDIRECTS = 2;
const MAX_ORIGIN_CONCURRENCY = 2;
export const ICON_URL_MAX_LENGTH = 2048;
const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const isCanonicalIconHostname = (hostname: string): boolean => {
  if (hostname.length > 253 || !HOSTNAME_PATTERN.test(hostname)) {
    return false;
  }
  const parsed = parseSafeOutboundUrl(`https://${hostname}/favicon.ico`);
  return Result.isOk(parsed) && parsed.value.hostname === hostname;
};

export type RegistrableIconSite = {
  readonly kind: "registrable-icon-site";
  readonly value: string;
};

class NotIconSite extends TaggedError("NotIconSite")<{
  message: string;
}> {}

export const toRegistrableIconSite = (hostname: string) => {
  if (!isCanonicalIconHostname(hostname)) {
    return Result.err(
      new NotIconSite({ message: "Hostname is not an icon site" }),
    );
  }
  const domain = getDomain(hostname, { allowPrivateDomains: false });
  if (domain === null) {
    return Result.err(
      new NotIconSite({ message: "Hostname has no registrable domain" }),
    );
  }
  return Result.ok({ kind: "registrable-icon-site", value: domain } as const);
};

const unavailableIcon = ({
  type,
  reason,
}: {
  type: "no-icon" | "temporary";
  reason: string;
}): LinkIconOutcome => {
  logger.debug("chat.link_icon.unavailable", { reason });
  return { type };
};

const isRetryableIconStatus = (status: number) =>
  status === 408 ||
  status === 425 ||
  status === 429 ||
  (status >= 500 && status <= 599);

type HttpsIconUrl = `https://${string}`;

export type ExactIconUrl = {
  readonly kind: "exact-icon-url";
  readonly value: HttpsIconUrl;
};

/**
 * What one cached icon belongs to. A site value is a bare registrable domain
 * and an exact value always carries a scheme, so the two never share a key.
 */
export type LinkIconTarget = RegistrableIconSite | ExactIconUrl;

const isHttpsIconUrl = (url: string): url is HttpsIconUrl =>
  url.startsWith("https://");

const normalizeExactIconUrl = (value: string): HttpsIconUrl | null => {
  if (value.length > ICON_URL_MAX_LENGTH) {
    return null;
  }
  const parsed = parseSafeOutboundUrl(value);
  if (Result.isError(parsed)) {
    return null;
  }
  const url = parsed.value;
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  return isHttpsIconUrl(url.href) ? url.href : null;
};

export const toExactIconUrl = (value: string): ExactIconUrl | null => {
  const normalized = normalizeExactIconUrl(value);
  return normalized === null
    ? null
    : { kind: "exact-icon-url", value: normalized };
};

type FetchIconBytes = (
  options: Parameters<typeof safeOutboundFetchBytes>[0] & { url: HttpsIconUrl },
) => ReturnType<typeof safeOutboundFetchBytes>;

type OriginOptions = {
  fetchBytes?: FetchIconBytes;
  now?: () => number;
};

/** The local admission bound complements the shared per-host lease. */
const createIconOrigin = ({
  fetchBytes = safeOutboundFetchBytes,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: OriginOptions = {}) => {
  let active = 0;

  return async (
    initialUrl: HttpsIconUrl,
    permit: ThirdPartyOutboundPermit,
    normalizeRedirect: (url: string) => HttpsIconUrl | null,
  ): Promise<LinkIconOutcome> => {
    if (active >= MAX_ORIGIN_CONCURRENCY) {
      return unavailableIcon({ type: "temporary", reason: "capacity" });
    }
    active += 1;
    const deadline = now() + ORIGIN_DEADLINE_MS;
    const signal = AbortSignal.timeout(ORIGIN_DEADLINE_MS);
    let url = initialUrl;
    let remainingBytes = LINK_ICON_MAX_BYTES;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const timeoutMs = deadline - now();
        if (timeoutMs <= 0 || signal.aborted) {
          return unavailableIcon({ type: "temporary", reason: "deadline" });
        }
        // Each invocation resolves and validates the complete DNS answer, then
        // pins those addresses to the socket, including redirected hosts.
        const response = await fetchBytes({
          url,
          permit,
          timeout: { type: "headers", ms: timeoutMs },
          signal,
          redirect: "manual",
          maxBytes: remainingBytes,
          headers: {
            Accept: "image/png, image/x-icon, image/vnd.microsoft.icon",
            "Accept-Encoding": "identity",
          },
        });
        if (Result.isError(response)) {
          return unavailableIcon({ type: "temporary", reason: "transport" });
        }
        const { headers, status, body } = response.value;
        remainingBytes -= body.byteLength;
        if (remainingBytes < 0) {
          return unavailableIcon({ type: "no-icon", reason: "size" });
        }
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (hop === MAX_REDIRECTS) {
            return unavailableIcon({
              type: "no-icon",
              reason: "redirect_limit",
            });
          }
          if (remainingBytes === 0) {
            return unavailableIcon({ type: "no-icon", reason: "size" });
          }
          const location = headers.get("location");
          if (!location) {
            return unavailableIcon({
              type: "no-icon",
              reason: "redirect_location",
            });
          }
          const redirectBase = url;
          const redirected = Result.try(() => new URL(location, redirectBase));
          if (Result.isError(redirected)) {
            return unavailableIcon({
              type: "no-icon",
              reason: "redirect_location",
            });
          }
          const redirectedUrl = redirected.value.href;
          const normalizedRedirect = normalizeRedirect(redirectedUrl);
          if (normalizedRedirect === null) {
            return unavailableIcon({
              type: "no-icon",
              reason: "redirect_target",
            });
          }
          url = normalizedRedirect;
          continue;
        }
        if (isRetryableIconStatus(status)) {
          return unavailableIcon({ type: "temporary", reason: "status" });
        }
        if (status !== 200) {
          return unavailableIcon({ type: "no-icon", reason: "status" });
        }
        const encoding = headers.get("content-encoding");
        if (encoding !== null && encoding.toLowerCase() !== "identity") {
          return unavailableIcon({ type: "no-icon", reason: "encoding" });
        }
        const mime =
          headers.get("content-type")?.split(";").at(0)?.trim().toLowerCase() ??
          "";
        const bytes = new Uint8Array(body);
        if (!isValidLinkIconImage(bytes, mime)) {
          return unavailableIcon({ type: "no-icon", reason: "image" });
        }
        if (now() >= deadline) {
          return unavailableIcon({ type: "temporary", reason: "deadline" });
        }
        return {
          type: "icon",
          icon: {
            bytes,
            mime: mime === "image/png" ? "image/png" : "image/x-icon",
          },
        };
      }
      return unavailableIcon({ type: "no-icon", reason: "redirect_limit" });
    } finally {
      active -= 1;
    }
  };
};

const normalizeFaviconUrl = (value: string): HttpsIconUrl | null => {
  const parsed = parseSafeOutboundUrl(value);
  if (
    Result.isError(parsed) ||
    !isHttpsIconUrl(value) ||
    !isCanonicalIconHostname(parsed.value.hostname) ||
    parsed.value.port !== "" ||
    parsed.value.hash !== "" ||
    parsed.value.search !== "" ||
    parsed.value.pathname !== "/favicon.ico"
  ) {
    return null;
  }
  return value;
};

export const createLinkIconOrigin = (options: OriginOptions = {}) => {
  const readOrigin = createIconOrigin(options);
  return async (site: RegistrableIconSite, permit: ThirdPartyOutboundPermit) =>
    await readOrigin(
      `https://${site.value}/favicon.ico`,
      permit,
      normalizeFaviconUrl,
    );
};

export const createExactIconOrigin = (options: OriginOptions = {}) => {
  const readOrigin = createIconOrigin(options);
  return async (url: string, permit: ThirdPartyOutboundPermit) => {
    const normalized = normalizeExactIconUrl(url);
    if (normalized === null) {
      return unavailableIcon({ type: "no-icon", reason: "url" });
    }
    return await readOrigin(normalized, permit, normalizeExactIconUrl);
  };
};
