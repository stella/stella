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

const requestUrl = (input: unknown): URL | undefined => {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return URL.canParse(input) ? new URL(input) : undefined;
  }
  return undefined;
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

// Replaces `owner[name]` with a function that refuses first: by throwing, as
// a socket factory does, or by rejecting, as `fetch` does. Returns the
// function that puts the original back.
const guardMethod = (
  owner: object,
  name: string,
  refuse: Refusal,
  failure: "throw" | "reject",
): (() => void) => {
  const original: unknown = Reflect.get(owner, name);
  if (typeof original !== "function") {
    return panic(`Cannot guard ${name}: it is not a function`);
  }
  const guarded = function guarded(this: unknown, ...args: unknown[]) {
    const error = refuse(args);
    if (error === undefined) {
      return Reflect.apply(original, this, args);
    }
    if (failure === "reject") {
      return Promise.reject(error);
    }
    throw error;
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
  const refuseFetch: Refusal = ([input]) => {
    const url = requestUrl(input);
    return url === undefined || LOCAL_URL_SCHEMES.has(url.protocol)
      ? undefined
      : refusal(url.hostname, "fetch");
  };

  // Bun's module-level factories open sockets without going through
  // Socket.prototype.connect, so each entry point is guarded on its own.
  const restores = [
    guardMethod(globalThis, "fetch", refuseFetch, "reject"),
    guardMethod(
      net.Socket.prototype,
      "connect",
      refuseSocket("node:net"),
      "throw",
    ),
    guardMethod(net, "connect", refuseSocket("node:net"), "throw"),
    guardMethod(net, "createConnection", refuseSocket("node:net"), "throw"),
    guardMethod(tls, "connect", refuseSocket("node:tls"), "throw"),
    guardMethod(Bun, "connect", refuseSocket("Bun.connect"), "throw"),
  ];

  installed = () => {
    for (const restore of restores.toReversed()) {
      restore();
    }
    installed = undefined;
  };
  return installed;
};
