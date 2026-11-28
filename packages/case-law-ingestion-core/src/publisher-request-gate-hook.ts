// parser-output-unchanged: publisher request gate hook controls request pacing only; parsed output is unchanged.
import { TaggedError } from "better-result";

import type { PublisherGateId } from "./publisher-gates";

export type PublisherGateClient = {
  send: (command: string, args: string[]) => unknown;
};

export type PublisherRequestGateConfig = {
  intervalMs: number;
  key: string;
  publisherCode: PublisherGateId;
  publisher: string;
  cooldown?: "shared";
};

export type PublisherRequestGateDependencies = {
  redis: () => PublisherGateClient | Promise<PublisherGateClient>;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
};

export class PublisherPacingStopped extends TaggedError(
  "PublisherPacingStopped",
)<{
  message: string;
  status: "pacing-deferred" | "pacing-unavailable";
  cause?: unknown;
}> {}

export type PublisherRequestSlot = ((signal?: AbortSignal) => Promise<void>) & {
  tryReserve: (signal?: AbortSignal) => Promise<boolean>;
  reserveImmediately: (signal?: AbortSignal) => Promise<void>;
  readCooldown: () => Promise<number | null>;
  defer: (durationMs: number, signal?: AbortSignal) => Promise<number>;
};

export type PublisherRequestGateImplementation = {
  createPublisherRequestSlot: (
    config: PublisherRequestGateConfig,
    dependencies?: PublisherRequestGateDependencies,
  ) => PublisherRequestSlot;
  publisherGateReserves: () => boolean;
};

const createPassthroughSlot = (): PublisherRequestSlot =>
  Object.assign(
    async (_signal?: AbortSignal): Promise<void> => {
      await Promise.resolve(undefined);
    },
    {
      tryReserve: async (_signal?: AbortSignal): Promise<boolean> =>
        await Promise.resolve(true),
      reserveImmediately: async (_signal?: AbortSignal): Promise<void> => {
        await Promise.resolve(undefined);
      },
      readCooldown: async (): Promise<number | null> =>
        await Promise.resolve(null),
      defer: async (
        _durationMs: number,
        _signal?: AbortSignal,
      ): Promise<number> => await Promise.resolve(0),
    },
  );

const PASSTHROUGH_PUBLISHER_REQUEST_GATE: PublisherRequestGateImplementation = {
  createPublisherRequestSlot: () => createPassthroughSlot(),
  publisherGateReserves: () => false,
};

let activePublisherRequestGate: PublisherRequestGateImplementation =
  PASSTHROUGH_PUBLISHER_REQUEST_GATE;

export const registerPublisherRequestGate = (
  implementation: PublisherRequestGateImplementation,
): void => {
  activePublisherRequestGate = implementation;
};

export const getPublisherRequestGate = (): PublisherRequestGateImplementation =>
  activePublisherRequestGate;

export const abortableSleep = async (
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (durationMs <= 0) {
    return;
  }
  if (signal?.aborted) {
    await Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError"),
    );
  }
  if (signal === undefined) {
    await Bun.sleep(durationMs);
    return;
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Bun.sleep(durationMs), aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};
