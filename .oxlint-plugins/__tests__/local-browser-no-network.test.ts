import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "local-browser-no-network";

test("rejects every way to send page content off the computer", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import http from "node:http";',
        'import { request } from "undici";',
        'import { fetchWithTimeout } from "@stll/fetch";',
        'import net from "node:net";',
        'import { connect } from "node:net";',
        "await fetch('https://example.com', { method: 'POST' });",
        "await globalThis.fetch('https://example.com');",
        "new WebSocket('wss://example.com');",
        "new EventSource('https://example.com');",
        "new XMLHttpRequest();",
        "navigator.sendBeacon('https://example.com', 'page');",
        "net.connect({ host: 'example.com', port: 443 });",
        "net.createConnection(443, 'example.com');",
        "connect({ path: '/tmp/a.sock', port: 1 });",
        "new net.Socket();",
        "await Bun.connect({ hostname: 'example.com', port: 443 });",
        'await import("node:https");',
        "fetchWithTimeout('https://example.com');",
        "new globalThis.WebSocket('wss://example.com');",
        "new window.EventSource('https://example.com');",
        "new self.XMLHttpRequest();",
        "globalThis.navigator.sendBeacon('https://example.com', 'page');",
        "await globalThis.Bun.connect({ hostname: 'example.com', port: 443 });",
      ].join("\n"),
    ),
  ).toEqual([
    1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  ]);
});

test("allows Unix sockets, local servers and names that only look alike", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import net from "node:net";',
        'import { createConnection } from "node:net";',
        "const socket = net.createConnection({ path: '/tmp/browser.sock' });",
        "createConnection({ path: '/tmp/browser.sock' });",
        "const server = net.createServer();",
        "Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });",
        "const fetch = (url: string) => url;",
        "fetch('local');",
        "const client = { connect: () => undefined };",
        "client.connect();",
        "const sockets = { WebSocket: class {} };",
        "new sockets.WebSocket();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
