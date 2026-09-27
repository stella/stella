import { TaggedError } from "better-result";

// A send's request as the harness hands it to the handler, torn down the
// moment the handler hands its response back, the way a finished request is:
// its signal aborts, and reading it from then on is a finding. A turn's run
// owns the turn from that point, so it must neither read the request nor end
// because the request did.

/** A read of a request after the handler handed its response back. */
class RequestReadAfterResponseError extends TaggedError(
  "RequestReadAfterResponseError",
)<{ message: string }> {}

export type TornDownRequest = {
  /** Reads of the request after `tearDown`, by property name. */
  readsAfterResponse: () => readonly string[];
  /** The request the handler receives. */
  request: Request;
  /** Ends the request: its signal aborts and every later read is recorded. */
  tearDown: () => void;
};

export const createTornDownRequest = ({
  signal,
  url,
}: {
  /** The page's own abort, which reaches the request until it ends. */
  signal: AbortSignal | undefined;
  url: string;
}): TornDownRequest => {
  const lifetime = new AbortController();
  const followPage = () => {
    lifetime.abort(signal?.reason);
  };
  if (signal?.aborted === true) {
    followPage();
  } else {
    signal?.addEventListener("abort", followPage, { once: true });
  }
  const served = new Request(url, { signal: lifetime.signal });
  const reads: string[] = [];
  let ended = false;
  const request = new Proxy(served, {
    get: (target, property) => {
      if (ended) {
        const name = String(property);
        reads.push(name);
        throw new RequestReadAfterResponseError({
          message: `The request's ${name} was read after its response was handed back`,
        });
      }
      // Native accessors need the real request as their receiver.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
  return {
    readsAfterResponse: () => reads,
    request,
    tearDown: () => {
      ended = true;
      signal?.removeEventListener("abort", followPage);
      lifetime.abort(new DOMException("The request has ended", "AbortError"));
    },
  };
};
