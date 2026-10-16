import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { isValidLinkIconImage } from "@/api/handlers/chat/link-icons/image";
import type { LinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { logger } from "@/api/lib/observability/logger";
import {
  parseSafeOutboundUrl,
  safeOutboundFetchBytes,
} from "@/api/lib/safe-outbound-fetch";

const LINK_ICON_MAX_BYTES = 64 * 1024;
const ORIGIN_DEADLINE_MS = 3000;
const MAX_REDIRECTS = 2;
const MAX_ORIGIN_CONCURRENCY = 2;
const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const isCanonicalIconHostname = (hostname: string): boolean => {
  if (hostname.length > 253 || !HOSTNAME_PATTERN.test(hostname)) {
    return false;
  }
  const parsed = parseSafeOutboundUrl(`https://${hostname}/favicon.ico`);
  return Result.isOk(parsed) && parsed.value.hostname === hostname;
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

type OriginOptions = {
  fetchBytes?: typeof safeOutboundFetchBytes;
  now?: () => number;
};

/** The local admission bound complements the shared per-host lease. */
export const createLinkIconOrigin = ({
  fetchBytes = safeOutboundFetchBytes,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: OriginOptions = {}) => {
  let active = 0;

  return async (
    hostname: string,
    permit: ThirdPartyOutboundPermit,
  ): Promise<LinkIconOutcome> => {
    if (!isCanonicalIconHostname(hostname)) {
      return unavailableIcon({ type: "no-icon", reason: "hostname" });
    }
    if (active >= MAX_ORIGIN_CONCURRENCY) {
      return unavailableIcon({ type: "temporary", reason: "capacity" });
    }
    active += 1;
    const deadline = now() + ORIGIN_DEADLINE_MS;
    const signal = AbortSignal.timeout(ORIGIN_DEADLINE_MS);
    let url = new URL(`https://${hostname}/favicon.ico`);
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
          const parsed = parseSafeOutboundUrl(redirected.value.toString());
          if (
            Result.isError(parsed) ||
            !isCanonicalIconHostname(parsed.value.hostname) ||
            parsed.value.port !== "" ||
            parsed.value.hash !== "" ||
            parsed.value.search !== "" ||
            parsed.value.pathname !== "/favicon.ico"
          ) {
            return unavailableIcon({
              type: "no-icon",
              reason: "redirect_target",
            });
          }
          url = parsed.value;
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
