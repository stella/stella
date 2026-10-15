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

// What a fake fetch was asked for, whichever input form it received.
const requestedUrl = (input: unknown): string => {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return typeof input === "string" ? input : "(not a URL)";
};
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
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/`);
    expect(await response.text()).toBe("ok");
  });

  test("only an explicitly allowed host passes the guard", async () => {
    const realFetch = globalThis.fetch;
    const reached: string[] = [];
    // A fake underneath the guard: nothing leaves the process.
    Reflect.set(globalThis, "fetch", async (input: unknown) => {
      reached.push(requestedUrl(input));
      return new Response("ok");
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
        fetch(`http://127.0.0.1:${String(server.port)}/away`),
      );
      expect(error).toBeInstanceOf(NetworkAccessError);
      expect(error).toHaveProperty("host", "example.com");
    });

    test("local redirects are followed with their method and body rules", async () => {
      uninstall = installNetworkGuard();
      using server = serve();
      const base = `http://127.0.0.1:${String(server.port)}`;
      const kept = await fetch(`${base}/hop`, { body: "x", method: "POST" });
      expect(await kept.text()).toBe("POST x");
      expect(kept.url).toBe(`${base}/final`);
      const switched = await fetch(`${base}/see-other`, {
        body: "x",
        method: "POST",
      });
      expect(await switched.text()).toBe("GET ");
    });

    test("a streamed upload is not buffered before the request starts", async () => {
      uninstall = installNetworkGuard();
      using server = Bun.serve({
        // Answers on the first chunk, while the upload is still open.
        fetch: async (request) => {
          const reader = request.body?.getReader();
          const first = await reader?.read();
          return new Response(new TextDecoder().decode(first?.value));
        },
        port: 0,
      });
      const upload = new TransformStream<Uint8Array, Uint8Array>();
      const writer = upload.writable.getWriter();
      const responding = fetch(`http://127.0.0.1:${String(server.port)}/`, {
        body: upload.readable,
        method: "POST",
      });
      await writer.write(new TextEncoder().encode("first"));
      const response = await responding;
      // The response arrived while the upload was still open.
      expect(await response.text()).toBe("first");
      writer.releaseLock();
    });

    describe("under a recording fake", () => {
      type Call = { url: string; init: RequestInit | undefined };
      const withFake = async (
        answer: (call: Call, index: number) => Response,
        body: (calls: Call[]) => Promise<void>,
      ) => {
        const realFetch = globalThis.fetch;
        const calls: Call[] = [];
        Reflect.set(
          globalThis,
          "fetch",
          async (input: unknown, init?: RequestInit) => {
            const call = {
              init,
              url: requestedUrl(input),
            };
            calls.push(call);
            return answer(call, calls.length - 1);
          },
        );
        try {
          uninstall = installNetworkGuard();
          await body(calls);
        } finally {
          uninstall?.();
          uninstall = undefined;
          Reflect.set(globalThis, "fetch", realFetch);
        }
      };
      const redirectOnce = (status: number) => (_call: Call, index: number) =>
        index === 0
          ? new Response(null, { headers: { location: "/next" }, status })
          : new Response("done");

      test("every hop keeps the caller's transport options", async () => {
        await withFake(redirectOnce(307), async (calls) => {
          const tlsOptions = { rejectUnauthorized: false };
          const init = { body: "payload", method: "PUT", tls: tlsOptions };
          await fetch("https://localhost:8443/start", init);
          expect(calls.map((call) => call.url)).toEqual([
            "https://localhost:8443/start",
            "https://localhost:8443/next",
          ]);
          for (const call of calls) {
            expect(Reflect.get(call.init ?? {}, "tls")).toBe(tlsOptions);
            expect(call.init?.redirect).toBe("manual");
          }
          expect(calls[1]?.init?.body).toBe("payload");
          expect(calls[1]?.init?.method).toBe("PUT");
        });
      });

      test("an upload stream is handed on as is, never copied", async () => {
        await withFake(
          () => new Response("ok"),
          async (calls) => {
            const upload = new ReadableStream<Uint8Array>();
            await fetch("http://127.0.0.1:1/", {
              body: upload,
              method: "POST",
            });
            expect(calls[0]?.init?.body).toBe(upload);
            expect(upload.locked).toBe(false);
          },
        );
      });

      test("a Request's signal still cancels the hops after a redirect", async () => {
        await withFake(redirectOnce(307), async (calls) => {
          const controller = new AbortController();
          await fetch(
            new Request("http://127.0.0.1:1/start", {
              signal: controller.signal,
            }),
          );
          expect(calls).toHaveLength(2);
          expect(calls[1]?.init?.signal).toBe(controller.signal);
        });
      });

      test("a streamed POST dropped by a 303 can follow a later 307", async () => {
        const statuses = [303, 307];
        await withFake(
          (_call, index) => {
            const status = statuses[index];
            return status === undefined
              ? new Response("done")
              : new Response(null, {
                  headers: { location: `/hop-${index}` },
                  status,
                });
          },
          async (calls) => {
            const response = await fetch("http://127.0.0.1:1/", {
              body: new ReadableStream<Uint8Array>(),
              method: "POST",
            });
            expect(await response.text()).toBe("done");
            expect(calls.map((call) => call.init?.method ?? "POST")).toEqual([
              "POST",
              "GET",
              "GET",
            ]);
            expect(calls[2]?.init?.body).toBeNull();
          },
        );
      });

      test("a 307 cannot resend a streamed body", async () => {
        await withFake(redirectOnce(307), async (calls) => {
          const error = await rejectionOf(
            fetch("http://127.0.0.1:1/", {
              body: new ReadableStream<Uint8Array>(),
              method: "POST",
            }),
          );
          expect(String(error)).toContain("cannot resend a streamed body");
          expect(calls).toHaveLength(1);
        });
      });
    });

    test("a remote proxy is refused even for a loopback target", async () => {
      uninstall = installNetworkGuard();
      for (const proxy of [
        "http://proxy.example:8080",
        { url: "http://proxy.example:8080" },
      ]) {
        const init: RequestInit = {};
        Reflect.set(init, "proxy", proxy);
        const error = await rejectionOf(fetch("http://127.0.0.1:1/", init));
        expect(error).toBeInstanceOf(NetworkAccessError);
        expect(error).toHaveProperty("host", "proxy.example");
      }
    });

    test("an undefined unix option is not a Unix socket", async () => {
      uninstall = installNetworkGuard();
      // Built at run time: the typed init does not admit an undefined unix.
      const init: RequestInit = {};
      Reflect.set(init, "unix", undefined);
      const error = await rejectionOf(fetch("http://example.com/", init));
      expect(error).toBeInstanceOf(NetworkAccessError);
    });

    test("manual redirects are left to the caller", async () => {
      uninstall = installNetworkGuard();
      using server = serve();
      const response = await fetch(
        `http://127.0.0.1:${String(server.port)}/away`,
        {
          redirect: "manual",
        },
      );
      expect(response.status).toBe(302);
    });
  });

  test("a remote proxy in the environment refuses the install", () => {
    for (const environment of [
      { HTTPS_PROXY: "http://proxy.example:3128" },
      { http_proxy: "http://proxy.example:3128" },
      { ALL_PROXY: "not a url" },
    ]) {
      expect(() => installNetworkGuard({ environment })).toThrow(
        NetworkAccessError,
      );
    }
    // A loopback proxy keeps every connection on this machine.
    uninstall = installNetworkGuard({
      environment: { HTTP_PROXY: "http://127.0.0.1:3128" },
    });
  });

  test("fetch.preconnect is refused for a remote host before it connects", () => {
    const realFetch = globalThis.fetch;
    const preconnected: string[] = [];
    const fake = Object.assign(async () => new Response("unused"), {
      preconnect: (target: string | URL) => {
        preconnected.push(String(target));
      },
    });
    Reflect.set(globalThis, "fetch", fake);
    try {
      uninstall = installNetworkGuard();
      expect(() => fetch.preconnect("https://example.com/")).toThrow(
        NetworkAccessError,
      );
      fetch.preconnect("http://127.0.0.1:1/");
      expect(preconnected).toEqual(["http://127.0.0.1:1/"]);
    } finally {
      uninstall?.();
      uninstall = undefined;
      Reflect.set(globalThis, "fetch", realFetch);
    }
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
    // The (port, options) overload carries the host in the second argument.
    expect(() => tls.connect(443, { host: "example.com" })).toThrow(
      NetworkAccessError,
    );
    expect(() => net.connect({ host: "203.0.113.7", port: 5432 })).toThrow(
      NetworkAccessError,
    );
    expect(() => new net.Socket().connect(443, "example.com")).toThrow(
      NetworkAccessError,
    );
  });

  test("Bun.connect to a remote host rejects", async () => {
    uninstall = installNetworkGuard();
    const error = await rejectionOf(
      Bun.connect({
        hostname: "example.com",
        port: 443,
        socket: { data: () => undefined },
      }),
    );
    expect(error).toBeInstanceOf(NetworkAccessError);
  });

  test("a stale uninstall cannot remove a later guard", async () => {
    const first = installNetworkGuard();
    first();
    uninstall = installNetworkGuard();
    first();
    first();
    const error = await rejectionOf(fetch("https://example.com/"));
    expect(error).toBeInstanceOf(NetworkAccessError);
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
