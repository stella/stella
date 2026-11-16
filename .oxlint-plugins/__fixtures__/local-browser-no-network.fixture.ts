// Passive regression fixture for
// `local-browser-no-network/local-browser-no-network`.

import net from "node:net";

// MUST flag: an HTTP client could send page content off the computer.
// oxlint-disable-next-line local-browser-no-network/local-browser-no-network -- fixture: HTTP clients are banned in the local browser transport
import "node:https";

// MUST flag: the global fetch sends anywhere.
export const send = async (body: string) =>
  // oxlint-disable-next-line local-browser-no-network/local-browser-no-network -- fixture: fetch is banned in the local browser transport
  await fetch("https://example.com", { body, method: "POST" });

// MUST flag: a Node socket aimed at a host and port.
// oxlint-disable-next-line local-browser-no-network/local-browser-no-network -- fixture: TCP sockets are banned in the local browser transport
export const remote = net.connect({ host: "example.com", port: 443 });

// Allowed: a Unix socket path on this computer.
// expect-clean: local-browser-no-network/local-browser-no-network
export const local = net.createConnection({ path: "/tmp/browser.sock" });
