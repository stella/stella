import { panic, Result } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import {
  PUBLISHER_GATES,
  reservePublisherGateSlot,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import type {
  SoftLawFetch,
  SoftLawBlockReason,
  SoftLawResponse,
  SoftLawFetchError,
} from "@/api/lib/legal-search/soft-law-access-types";
import {
  SoftLawAccessError,
  SoftLawBlockedError,
  SoftLawContentTypeMismatchError,
} from "@/api/lib/legal-search/soft-law-access-types";
import type { SoftLawAccessPolicy } from "@/api/lib/legal-search/soft-law-types";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const SOFT_LAW_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type PublisherBodyReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "read" | "cancel"
>;
const readPublisherBytes = async (reader: PublisherBodyReader) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > SOFT_LAW_RESPONSE_MAX_BYTES) {
      return Result.err(
        new SoftLawAccessError({
          message: "Publisher response exceeds the byte limit",
        }),
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Result.ok(bytes);
};

type ReadPublisherBodyOptions = {
  reader: PublisherBodyReader;
  signal: AbortSignal;
  read: () => Promise<Result<SoftLawResponse, SoftLawFetchError>>;
};
const readPublisherBody = async ({
  reader,
  signal,
  read,
}: ReadPublisherBodyOptions) => {
  const bodySignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  let rejectRead!: () => void;
  const aborted = new Promise<Result<never, SoftLawAccessError>>((resolve) => {
    rejectRead = () =>
      resolve(
        Result.err(
          new SoftLawAccessError({
            message: "Publisher response body read was aborted",
          }),
        ),
      );
  });
  bodySignal.addEventListener("abort", rejectRead, { once: true });
  try {
    bodySignal.throwIfAborted();
    return await Promise.race([read(), aborted]);
  } finally {
    bodySignal.removeEventListener("abort", rejectRead);
    await reader.cancel();
  }
};

export const detectSoftLawBlock = (status: number, body: string) => {
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "rate_limited";
  }
  // Match challenge markup, not prose discussing captchas in guidance.
  if (
    /<title[^>]*>\s*(?:just a moment|attention required|access denied)|cf-chl-|id=["']challenge-form|hcaptcha\.com\/1\/api|awswaf\.com|verify you are human/iu.test(
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
    return panic("Invalid publisher access window");
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
  now?: () => Date;
  request?: typeof fetchWithTimeout;
  reserve?: typeof reservePublisherGateSlot;
  beforeRequest?: () => Promise<void | Result<void, unknown>>;
};

/** Every response is inspected before the adapter receives it; no retries. */
export const createSoftLawFetch = ({
  policy,
  signal,
  now = () => new Date(),
  request = fetchWithTimeout,
  reserve = reservePublisherGateSlot,
  beforeRequest,
}: CreateSoftLawFetchOptions): SoftLawFetch => {
  let blocked: SoftLawBlockReason | null = null;
  let windowState: "open" | "deferred_window" = "open";
  let leaseState: "active" | "lost" = "active";
  const getLeaseState = () => leaseState;
  const getBlockReason = () => blocked;
  const stop = (reason: SoftLawBlockReason) => {
    blocked = reason;
    return Result.err(
      new SoftLawBlockedError({
        message: "Publisher blocked this source",
        reason,
      }),
    );
  };
  const fetchInternal = async (
    rawUrl: string,
    options?: { expectedContentTypes: readonly string[] },
  ) => {
    if (getLeaseState() === "lost") {
      return Result.err(
        new SoftLawAccessError({ message: "Ingestion lease was lost" }),
      );
    }
    const initialBlock = getBlockReason();
    if (initialBlock) {
      return stop(initialBlock);
    }
    const gate = PUBLISHER_GATES[policy.publisherGate];
    if (
      gate.intervalMs < 1000 ||
      !/^Stella\/[^\s]+ \(\+https:\/\/[^\s)]+\)$/u.test(policy.userAgent)
    ) {
      return Result.err(
        new SoftLawAccessError({
          message: "Publisher access requires pacing and a contact user agent",
        }),
      );
    }
    const url = restrictOutboundUrl({
      rawUrl,
      hostPolicy: {
        type: "exact-origin",
        origins: gate.hosts.map((host) => `https://${host}`),
      },
    });
    if (!url) {
      return Result.err(
        new SoftLawAccessError({
          message: "URL is outside the publisher policy",
        }),
      );
    }
    await reserve(policy.publisherGate, signal);
    if (!softLawAccessWindowOpen(policy, now())) {
      windowState = "deferred_window";
      return Result.err(
        new SoftLawAccessError({
          message: "Publisher access window is closed",
        }),
      );
    }
    signal.throwIfAborted();
    const reservedBlock = getBlockReason();
    if (reservedBlock) {
      return stop(reservedBlock);
    }
    const lease = await Result.tryPromise(async () => await beforeRequest?.());
    if (
      Result.isError(lease) ||
      (lease.value !== undefined && Result.isError(lease.value))
    ) {
      leaseState = "lost";
      return Result.err(
        new SoftLawAccessError({
          message: "Ingestion lease was lost",
          cause: Result.isError(lease) ? lease.error.cause : lease.value,
        }),
      );
    }
    signal.throwIfAborted();
    if (getLeaseState() === "lost") {
      return Result.err(
        new SoftLawAccessError({ message: "Ingestion lease was lost" }),
      );
    }
    const renewedBlock = getBlockReason();
    if (renewedBlock) {
      return stop(renewedBlock);
    }
    const response = await request(url, {
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      redirect: "manual",
      headers: { "User-Agent": policy.userAgent },
    });
    const statusBlock = detectSoftLawBlock(response.status, "");
    if (statusBlock) {
      blocked = statusBlock;
      await response.body?.cancel();
      return stop(statusBlock);
    }
    const location = response.headers.get("location");
    if (
      response.status >= 300 &&
      response.status < 400 &&
      location &&
      /challenge|captcha|cdn-cgi|access-denied/iu.test(location)
    ) {
      blocked = "challenge";
      await response.body?.cancel();
      return stop("challenge");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return Result.err(
        new SoftLawAccessError({
          message: response.ok
            ? "Publisher returned no response body"
            : `Publisher returned HTTP ${response.status}`,
        }),
      );
    }
    const bodyRead = async () => {
      const read = await readPublisherBytes(reader);
      if (Result.isError(read)) {
        return read;
      }
      const bytes = read.value;
      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const inspectText =
        /^(?:text\/|application\/(?:xhtml\+xml|xml|json))/iu.test(contentType);
      const block = detectSoftLawBlock(
        response.status,
        inspectText
          ? new TextDecoder().decode(bytes.subarray(0, 64 * 1024))
          : "",
      );
      if (block) {
        return stop(block);
      }
      if (!response.ok) {
        return Result.err(
          new SoftLawAccessError({
            message: `Publisher returned HTTP ${response.status}`,
          }),
        );
      }
      const mime = contentType.split(";").at(0)?.trim().toLowerCase();
      if (options && !options.expectedContentTypes.includes(mime ?? "")) {
        return Result.err(
          new SoftLawContentTypeMismatchError({
            message:
              "Publisher response content type does not match the requested surface",
            contentType,
          }),
        );
      }
      return Result.ok({
        bytes,
        contentType,
      });
    };
    // Keep a deadline on streamed bodies as well as response headers.
    return await readPublisherBody({ reader, signal, read: bodyRead });
  };
  const fetch: SoftLawFetch = Object.assign(
    async (
      rawUrl: string,
      options?: { expectedContentTypes: readonly string[] },
    ) => {
      const result = await Result.tryPromise({
        try: async () => await fetchInternal(rawUrl, options),
        catch: (cause) =>
          new SoftLawAccessError({
            message: "Publisher request failed",
            cause,
          }),
      });
      return result.andThen((response) => response);
    },
    {
      getBlockReason,
      getWindowState: () => windowState,
      getLeaseState,
    },
  );
  return Object.freeze(fetch);
};
