import { Result } from "better-result";

import { ServerUrlError } from "./errors";
import { parseUrl } from "./http";

/**
 * Hosts a development build reaches over plain http: a simulator's own
 * loopback and the Android emulator's alias for the machine running it. A
 * release build never does: on a phone `10.0.2.2` is just an address on
 * whatever network it joined, and tokens and matter data cross this
 * connection.
 */
const PLAIN_HTTP_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "10.0.2.2",
]);

export type TransportPolicy = {
  /** Development builds only (`__DEV__`). */
  readonly allowPlainHttp: boolean;
};

/** Whether the app may send credentials to this URL. */
export const isSecureTransport = (
  url: URL,
  { allowPlainHttp }: TransportPolicy,
): boolean =>
  url.protocol === "https:" ||
  (allowPlainHttp &&
    url.protocol === "http:" &&
    PLAIN_HTTP_HOSTS.has(url.hostname));

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;

/**
 * The server origin a person typed, or why it cannot be one. A bare host is
 * taken as https. Only the origin is kept: every path the app calls is
 * absolute on it, so a pasted page URL still names the right server.
 * Self-hosting is first-class, so no hosted origin is assumed.
 */
export const parseServerUrl = (
  input: string,
  policy: TransportPolicy,
): Result<string, ServerUrlError> => {
  const trimmed = input.trim();
  const url = parseUrl(
    HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  if (url === null || url.hostname === "") {
    return Result.err(
      new ServerUrlError({ message: "The server address is not a URL" }),
    );
  }
  if (url.username !== "" || url.password !== "") {
    return Result.err(
      new ServerUrlError({
        message: "The server address must not carry credentials",
      }),
    );
  }
  if (!isSecureTransport(url, policy)) {
    return Result.err(
      new ServerUrlError({ message: "The server address must use https" }),
    );
  }
  return Result.ok(url.origin);
};
