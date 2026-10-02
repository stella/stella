import { TaggedError } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import {
  PUBLISHER_GATES,
  reservePublisherGateSlot,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import type { SoftLawAccessPolicy } from "@/api/lib/legal-search/soft-law-types";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

export const SOFT_LAW_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
export const SOFT_LAW_BLOCK_REASONS = [
  "forbidden",
  "rate_limited",
  "challenge",
] as const;
export class SoftLawBlockedError extends TaggedError("SoftLawBlockedError")<{
  message: string;
  reason: (typeof SOFT_LAW_BLOCK_REASONS)[number];
}> {}
export class SoftLawAccessError extends TaggedError("SoftLawAccessError")<{
  message: string;
}> {}
export type SoftLawResponse = { bytes: Uint8Array; contentType: string };
export type SoftLawFetch = (url: string) => Promise<SoftLawResponse>;

export const detectSoftLawBlock = (status: number, body: string) => {
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "rate_limited";
  }
  // Match challenge markup, not prose discussing captchas in guidance.
  if (
    /<title[^>]*>\s*(?:just a moment|attention required|access denied)|cf-chl-|id=["']challenge-form|class=["'][^"']*g-recaptcha|hcaptcha\.com\/1\/api|awswaf\.com|verify you are human/iu.test(
      body,
    )
  ) {
    return "challenge";
  }
  return null;
};

export const softLawAccessWindowOpen = (
  policy: SoftLawAccessPolicy,
  now: Date,
): boolean => {
  if (policy.window.type === "any_time") {
    return true;
  }
  const { startHour, endHour, timeZone } = policy.window;
  if (
    ![startHour, endHour].every(
      (hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23,
    ) ||
    startHour === endHour
  ) {
    throw new SoftLawAccessError({
      message: "Invalid publisher access window",
    });
  }
  const hour = Number(
    new Intl.DateTimeFormat("en", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
};

type CreateSoftLawFetchOptions = {
  policy: SoftLawAccessPolicy;
  signal: AbortSignal;
  beforeRequest: () => Promise<void>;
  now?: () => Date;
  request?: typeof fetchWithTimeout;
  reserve?: typeof reservePublisherGateSlot;
};

/** Every response is inspected before the adapter receives it; no retries. */
export const createSoftLawFetch =
  ({
    policy,
    signal,
    beforeRequest,
    now = () => new Date(),
    request = fetchWithTimeout,
    reserve = reservePublisherGateSlot,
  }: CreateSoftLawFetchOptions): SoftLawFetch =>
  async (rawUrl) => {
    const gate = PUBLISHER_GATES[policy.publisherGate];
    if (
      gate.intervalMs < 1000 ||
      !/^Stella\/[^\s]+ \(\+https:\/\/[^\s)]+\)$/u.test(policy.userAgent)
    ) {
      throw new SoftLawAccessError({
        message: "Publisher access requires pacing and a contact user agent",
      });
    }
    const url = restrictOutboundUrl({
      rawUrl,
      hostPolicy: {
        type: "exact-origin",
        origins: gate.hosts.map((host) => `https://${host}`),
      },
    });
    if (!url) {
      throw new SoftLawAccessError({
        message: "URL is outside the publisher policy",
      });
    }
    await beforeRequest();
    await reserve(policy.publisherGate, signal);
    if (!softLawAccessWindowOpen(policy, now())) {
      throw new SoftLawAccessError({
        message: "Publisher access window is closed",
      });
    }
    signal.throwIfAborted();
    await beforeRequest();
    const response = await request(url, {
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      redirect: "manual",
      headers: { "User-Agent": policy.userAgent },
    });
    const statusBlock = detectSoftLawBlock(response.status, "");
    if (statusBlock) {
      await response.body?.cancel();
      throw new SoftLawBlockedError({
        message: "Publisher blocked this source",
        reason: statusBlock,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new SoftLawAccessError({
        message: response.ok
          ? "Publisher returned no response body"
          : `Publisher returned HTTP ${response.status}`,
      });
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const bodyRead = async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        size += next.value.byteLength;
        if (size > SOFT_LAW_RESPONSE_MAX_BYTES) {
          throw new SoftLawAccessError({
            message: "Publisher response exceeds the byte limit",
          });
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const block = detectSoftLawBlock(
        response.status,
        new TextDecoder().decode(bytes.subarray(0, 64 * 1024)),
      );
      if (block) {
        throw new SoftLawBlockedError({
          message: "Publisher returned a challenge",
          reason: block,
        });
      }
      if (!response.ok) {
        throw new SoftLawAccessError({
          message: `Publisher returned HTTP ${response.status}`,
        });
      }
      return {
        bytes,
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
      };
    };
    // Keep a deadline on streamed bodies as well as response headers.
    const bodySignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    let rejectRead!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectRead = () =>
        reject(
          new SoftLawAccessError({
            message: "Publisher response body read was aborted",
          }),
        );
    });
    bodySignal.addEventListener("abort", rejectRead, { once: true });
    try {
      bodySignal.throwIfAborted();
      return await Promise.race([bodyRead(), aborted]);
    } finally {
      bodySignal.removeEventListener("abort", rejectRead);
      await reader.cancel();
    }
  };
