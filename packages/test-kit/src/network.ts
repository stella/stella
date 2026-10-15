import { panic } from "better-result";
import net from "node:net";
import tls from "node:tls";

/**
 * Tests talk only to this machine. The guard refuses outbound connections to
 * any host that is not loopback (or explicitly allowed), so a test that would
 * depend on the internet, a third-party API or DNS fails at once with the
 * host it tried to reach, instead of passing or hanging depending on the
 * network of the machine that runs it.
 *
 * Covered: `fetch`, `node:net` sockets (and everything built on them:
 * `node:tls`, Postgres and Redis clients) and `Bun.connect`.
 */

export class NetworkAccessError extends Error {
  override readonly name = "NetworkAccessError";
  readonly host: string;

  constructor(host: string, via: string) {
    super(
      `Tests may not reach ${host} (via ${via}). Use a local server or a fake; ` +
        "loopback hosts are allowed.",
    );
    this.host = host;
  }
}

export type NetworkGuardOptions = {
  /** Extra host names that count as local, e.g. a CI service container. */
  allowHosts?: readonly string[];
};

const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

export const isLoopbackHost = (host: string): boolean => {
  const name = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (LOOPBACK_NAMES.has(name) || name.endsWith(".localhost")) {
    return true;
  }
  // 127.0.0.0/8, also as an IPv4-mapped IPv6 address.
  const v4 = name.startsWith("::ffff:") ? name.slice("::ffff:".length) : name;
  return net.isIPv4(v4) && v4.startsWith("127.");
};

const LOCAL_URL_SCHEMES = new Set(["blob:", "data:", "file:"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

type FetchRefusal = (url: URL) => NetworkAccessError | undefined;

// What a hop needs from the caller's request, whichever form it came in.
const requestParts = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
) => {
  const request = input instanceof Request ? input : undefined;
  const initBody = init?.body ?? undefined;
  return {
    headers: new Headers(init?.headers ?? request?.headers),
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    redirect: init?.redirect ?? request?.redirect ?? "follow",
    // Only a body given in `init` that is not a stream can be sent again.
    replayable:
      initBody === undefined
        ? (request?.body ?? null) === null
        : !(initBody instanceof ReadableStream),
  };
};

// 303, and 301/302 after a POST, continue as a GET without the body.
const dropsBody = (status: number, method: string) =>
  status === 303 || ((status === 301 || status === 302) && method === "POST");

const deleteHeaders = (headers: Headers, names: readonly string[]) => {
  for (const name of names) {
    headers.delete(name);
  }
};

/**
 * `fetch` that checks every hop. A redirect is followed here, one checked
 * hop at a time, because the platform would otherwise follow a redirect from
 * an allowed server to any host without asking the guard. Each hop goes out
 * with the caller's own `init` (Bun transport options such as `tls` included)
 * and `redirect: "manual"`; bodies are never copied. As in the fetch
 * standard, a 307/308 can resend only a body that is not a stream. The
 * returned response is the last hop's (its `url` is the final URL;
 * `redirected` is false).
 */
const guardedFetch =
  (original: typeof fetch, refuse: FetchRefusal) =>
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const unix: unknown =
      init === undefined ? undefined : Reflect.get(init, "unix");
    if (typeof unix === "string" && unix.length > 0) {
      return await original(input, init); // a Unix socket stays on this machine
    }
    const href = input instanceof Request ? input.url : String(input);
    if (!URL.canParse(href)) {
      return await original(input, init); // fetch reports the bad URL itself
    }
    let url = new URL(href);
    if (LOCAL_URL_SCHEMES.has(url.protocol)) {
      return await original(input, init);
    }
    const first = refuse(url);
    if (first !== undefined) {
      throw first;
    }
    const parts = requestParts(input, init);
    if (parts.redirect !== "follow") {
      return await original(input, init);
    }
    let { method } = parts;
    const { headers, replayable } = parts;
    let body = init?.body;
    let response = await original(input, { ...init, redirect: "manual" });
    for (let hops = 0; ; hops += 1) {
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) {
        return response;
      }
      // oxlint-disable-next-line no-await-in-loop -- the redirect body is discarded before the next hop.
      await response.body?.cancel();
      if (hops >= MAX_REDIRECTS) {
        return panic(`fetch: more than ${MAX_REDIRECTS} redirects`);
      }
      const next = new URL(location, url);
      const refused = refuse(next);
      if (refused !== undefined) {
        throw refused;
      }
      if (next.origin !== url.origin) {
        deleteHeaders(headers, CREDENTIAL_HEADERS);
      }
      if (dropsBody(response.status, method)) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        deleteHeaders(headers, ["content-type", "content-length"]);
      } else if (!replayable) {
        return panic(
          `fetch: a ${response.status} redirect cannot resend a streamed body`,
        );
      }
      url = next;
      // oxlint-disable-next-line no-await-in-loop -- each hop depends on the previous response.
      response = await original(url.href, {
        ...init,
        body: body ?? null,
        headers,
        method,
        redirect: "manual",
      });
    }
  };

const guardFetch = (refuse: FetchRefusal): (() => void) => {
  const original = globalThis.fetch;
  Reflect.set(globalThis, "fetch", guardedFetch(original, refuse));
  return () => Reflect.set(globalThis, "fetch", original);
};

type SocketTarget = {
  host?: unknown;
  hostname?: unknown;
  path?: unknown;
  unix?: unknown;
};

const socketHost = (args: readonly unknown[]): string | undefined => {
  const [first, second] = args;
  if (typeof first === "object" && first !== null) {
    const target: SocketTarget = first;
    if (typeof target.path === "string" || typeof target.unix === "string") {
      return undefined;
    }
    const host = target.host ?? target.hostname;
    return typeof host === "string" ? host : "localhost";
  }
  if (typeof first === "string" && !/^\d+$/u.test(first)) {
    return undefined; // a Unix socket path
  }
  return typeof second === "string" ? second : "localhost";
};

let installed: (() => void) | undefined;

type Refusal = (args: unknown[]) => NetworkAccessError | undefined;

// Replaces the socket factory `owner[name]` with one that throws, as the
// platform does for a bad target, before connecting to a refused host.
// Returns the function that puts the original back.
const guardMethod = (
  owner: object,
  name: string,
  refuse: Refusal,
): (() => void) => {
  const original: unknown = Reflect.get(owner, name);
  if (typeof original !== "function") {
    return panic(`Cannot guard ${name}: it is not a function`);
  }
  const guarded = function guarded(this: unknown, ...args: unknown[]) {
    const error = refuse(args);
    if (error !== undefined) {
      throw error;
    }
    return Reflect.apply(original, this, args);
  };
  Reflect.set(owner, name, guarded);
  if (Reflect.get(owner, name) !== guarded) {
    panic(`Could not install the network guard on ${name}`);
  }
  return () => Reflect.set(owner, name, original);
};

/**
 * Installs the guard process-wide and returns its uninstall function.
 * Installing twice is a setup bug and panics.
 */
export const installNetworkGuard = ({
  allowHosts = [],
}: NetworkGuardOptions = {}): (() => void) => {
  if (installed !== undefined) {
    panic("The network guard is already installed");
  }
  const allowed = new Set(allowHosts.map((host) => host.toLowerCase()));
  const refusal = (host: string | undefined, via: string) =>
    host === undefined ||
    isLoopbackHost(host) ||
    allowed.has(host.toLowerCase())
      ? undefined
      : new NetworkAccessError(host, via);
  const refuseSocket =
    (via: string): Refusal =>
    (args) =>
      refusal(socketHost(args), via);
  // Bun's module-level factories open sockets without going through
  // Socket.prototype.connect, so each entry point is guarded on its own.
  const restores = [
    guardFetch((url) => refusal(url.hostname, "fetch")),
    guardMethod(net.Socket.prototype, "connect", refuseSocket("node:net")),
    guardMethod(net, "connect", refuseSocket("node:net")),
    guardMethod(net, "createConnection", refuseSocket("node:net")),
    guardMethod(tls, "connect", refuseSocket("node:tls")),
    guardMethod(Bun, "connect", refuseSocket("Bun.connect")),
  ];

  installed = () => {
    for (const restore of restores.toReversed()) {
      restore();
    }
    installed = undefined;
  };
  return installed;
};
