import { TaggedError } from "better-result";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

// The preload is confined to verification: refresh commands retain their transport.
class OfflineCheckNetworkError extends TaggedError("OfflineCheckNetworkError")<{
  message: string;
}> {}

// A declaration is constructable, so calls and constructors throw the same error.
const checkName = Bun.main || "unknown check";

function disabledNetwork(): never {
  process.exitCode = 1;
  throw new OfflineCheckNetworkError({
    message: `network disabled in offline check: ${checkName}`,
  });
}

const denyTransport = (target: object, key: string) => {
  Object.defineProperty(target, key, {
    configurable: false,
    writable: false,
    value: disabledNetwork,
  });
};

const denyDns = (target: object) => {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (/^(?:lookup|resolve|reverse|prefetch)/u.test(key)) {
      denyTransport(target, key);
    }
  }
};

if (process.argv.includes("--check")) {
  denyTransport(globalThis, "fetch");
  for (const key of ["WebSocket", "XMLHttpRequest", "EventSource"]) {
    if (key in globalThis) {
      denyTransport(globalThis, key);
    }
  }
  for (const target of [http, https]) {
    denyTransport(target.Agent.prototype, "createConnection");
    denyTransport(target.globalAgent, "createConnection");
    for (const key of ["request", "get", "Agent"]) {
      denyTransport(target, key);
    }
  }
  denyTransport(http, "ClientRequest");
  // Bun also exposes the browser WebSocket constructor through node:http.
  if ("WebSocket" in http) {
    denyTransport(http, "WebSocket");
  }
  denyTransport(net.Socket.prototype, "connect");
  for (const key of ["connect", "createConnection"]) {
    denyTransport(net, key);
  }
  denyTransport(tls, "connect");
  denyTransport(tls, "TLSSocket");
  denyTransport(http2, "connect");
  for (const key of ["connect", "send"]) {
    denyTransport(dgram.Socket.prototype, key);
  }
  denyTransport(dgram, "createSocket");
  for (const target of [dns, dnsPromises]) {
    denyDns(target);
    denyDns(target.Resolver.prototype);
    denyTransport(target, "Resolver");
  }
  denyTransport(Bun, "connect");
  denyTransport(Bun, "udpSocket");
  for (const key of ["spawn", "spawnSync", "$"]) {
    denyTransport(Bun, key);
  }
  for (const key of [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync",
  ]) {
    denyTransport(childProcess, key);
  }
  denyDns(Bun.dns);
  syncBuiltinESMExports();
}
