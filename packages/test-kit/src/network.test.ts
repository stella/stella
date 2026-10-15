import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  NetworkAccessError,
  installNetworkGuard,
  isLoopbackHost,
} from "./network.ts";

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe("loopback hosts", () => {
  test.each([
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "127.0.0.1",
    "127.10.0.3",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ])("%s is local", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each([
    "example.com",
    "localhost.example.com",
    "128.0.0.1",
    "10.0.0.1",
    "::2",
    "",
  ])("%s is not local", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("network guard", () => {
  test("fetch to a remote host rejects before any request", async () => {
    uninstall = installNetworkGuard();
    const error = await rejectionOf(fetch("https://example.com/x"));
    expect(error).toBeInstanceOf(NetworkAccessError);
    expect(error).toHaveProperty("host", "example.com");
  });

  test("fetch to a loopback server still works", async () => {
    uninstall = installNetworkGuard();
    using server = Bun.serve({ fetch: () => new Response("ok"), port: 0 });
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await response.text()).toBe("ok");
  });

  test("only an explicitly allowed host passes the guard", async () => {
    const realFetch = globalThis.fetch;
    const reached: string[] = [];
    // A fake underneath the guard: nothing leaves the process.
    Reflect.set(globalThis, "fetch", (input: unknown) => {
      reached.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response("ok"));
    });
    try {
      uninstall = installNetworkGuard({ allowHosts: ["Postgres"] });
      expect(await (await fetch("http://postgres:5432/")).text()).toBe("ok");
      expect(
        await rejectionOf(fetch("http://postgres.example/")),
      ).toBeInstanceOf(NetworkAccessError);
      expect(reached).toEqual(["http://postgres:5432/"]);
    } finally {
      uninstall?.();
      uninstall = undefined;
      Reflect.set(globalThis, "fetch", realFetch);
    }
  });

  describe("redirects", () => {
    const serve = () =>
      Bun.serve({
        fetch: async (request) => {
          const { pathname } = new URL(request.url);
          switch (pathname) {
            case "/away":
              return Response.redirect("http://example.com/elsewhere", 302);
            case "/hop":
              return new Response(null, {
                headers: { location: "/final" },
                status: 307,
              });
            case "/see-other":
              return new Response(null, {
                headers: { location: "/final" },
                status: 303,
              });
            case "/final":
              return new Response(`${request.method} ${await request.text()}`);
            default:
              return new Response("missing", { status: 404 });
          }
        },
        port: 0,
      });

    test("a loopback redirect to a remote host is refused", async () => {
      uninstall = installNetworkGuard();
      using server = serve();
      const error = await rejectionOf(
        fetch(`http://127.0.0.1:${server.port}/away`),
      );
      expect(error).toBeInstanceOf(NetworkAccessError);
      expect(error).toHaveProperty("host", "example.com");
    });

    test("local redirects are followed with their method and body rules", async () => {
      uninstall = installNetworkGuard();
      using server = serve();
      const base = `http://127.0.0.1:${server.port}`;
      const kept = await fetch(`${base}/hop`, { body: "x", method: "POST" });
      expect(await kept.text()).toBe("POST x");
      expect(kept.url).toBe(`${base}/final`);
      const switched = await fetch(`${base}/see-other`, {
        body: "x",
        method: "POST",
      });
      expect(await switched.text()).toBe("GET ");
    });

    test("manual redirects are left to the caller", async () => {
      uninstall = installNetworkGuard();
      using server = serve();
      const response = await fetch(`http://127.0.0.1:${server.port}/away`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);
    });
  });

  test("data and blob URLs are not network access", async () => {
    uninstall = installNetworkGuard();
    const response = await fetch("data:text/plain,hello");
    expect(await response.text()).toBe("hello");
  });

  test("node:net and node:tls sockets to a remote host throw", () => {
    uninstall = installNetworkGuard();
    expect(() => net.createConnection(5432, "203.0.113.7")).toThrow(
      NetworkAccessError,
    );
    expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(
      NetworkAccessError,
    );
    expect(() => net.connect({ host: "203.0.113.7", port: 5432 })).toThrow(
      NetworkAccessError,
    );
    expect(() => new net.Socket().connect(443, "example.com")).toThrow(
      NetworkAccessError,
    );
  });

  test("Bun.connect to a remote host throws", () => {
    uninstall = installNetworkGuard();
    expect(() =>
      Bun.connect({
        hostname: "example.com",
        port: 443,
        socket: { data: () => undefined },
      }),
    ).toThrow(NetworkAccessError);
  });

  test("uninstall restores the originals and a second install panics", () => {
    const originalFetch = globalThis.fetch;
    const originalConnect = net.Socket.prototype.connect;
    const originalNetConnect = net.connect;
    const remove = installNetworkGuard();
    expect(() => installNetworkGuard()).toThrow("already installed");
    remove();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(net.Socket.prototype.connect).toBe(originalConnect);
    expect(net.connect).toBe(originalNetConnect);
  });
});
