import type { RequestExceptionScope } from "@stll/errors";

export type ScopedResponse = Pick<
  Response,
  "clone" | "headers" | "ok" | "status" | "url"
>;

type ScopedResponseObservation = {
  /**
   * The same response returned to the API caller. This view exposes no body
   * readers: clone only when a body must be read for observation, and never
   * consume this body.
   */
  readonly response: ScopedResponse;
  readonly scope: RequestExceptionScope;
};

export type ScopedResponseObserver = (
  context: ScopedResponseObservation,
) => void | Promise<void>;
