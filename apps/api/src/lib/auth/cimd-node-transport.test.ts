import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const PROBE_RESULT_PREFIX = "CIMD_PROBE:";
const IPV6 = "2606:4700:4700::1111";
const IPV4 = "1.1.1.1";
const ipv6Address = { address: IPV6, family: 6 };
const ipv4Address = { address: IPV4, family: 4 };
const addresses = [ipv6Address, ipv4Address];

type ProbeOptions = {
  addresses: { address: string; family: number }[];
  outcomes: (
    | "refused"
    | "stall"
    | "success"
    | "redirect"
    | "connected-error"
    | "slow-response"
  )[];
  all?: boolean;
  timeoutMs?: number;
  stallDns?: boolean;
  preAborted?: boolean;
};

// Built-in module mocks stay in an isolated test runner so concurrent auth tests
// retain real transports and Bun applies mocks to the dependency's ESM imports.
const probe = async (options: ProbeOptions) => {
  const script = `
    import { mock, test } from "bun:test";
    import { EventEmitter } from "node:events";
    import { Readable } from "node:stream";
    test("isolated CIMD transport probe", async () => {
    const config = ${JSON.stringify(options)};
    let resolutions = 0;
    const attempts = [];
    const authorities = [];
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("overall deadline", "TimeoutError"));
    if (config.preAborted) abort();
    // Initialize built-in ESM records before replacing their exports.
    await import("node:dns/promises");
    await import("node:https");
    mock.module("node:dns/promises", () => ({
      lookup: async () => {
        resolutions++;
        if (config.stallDns) return new Promise(() => {});
        return config.addresses;
      },
    }));
    mock.module("node:https", () => ({
      request: (url, options, respond) => {
        const req = new EventEmitter();
        let destroyed = false;
        let responseTimer;
        const onAbort = () => req.destroy(options.signal.reason);
        req.destroy = (error) => {
          if (destroyed) return req;
          destroyed = true;
          clearTimeout(responseTimer);
          options.signal.removeEventListener("abort", onAbort);
          queueMicrotask(() => req.emit("error", error));
          return req;
        };
        req.end = () => {
          options.signal.addEventListener("abort", onAbort, { once: true });
          queueMicrotask(() => {
            if (destroyed) return;
            const socket = new EventEmitter();
            req.emit("socket", socket);
            options.lookup(url.hostname, { all: config.all }, (error, address, family) => {
              if (error) return req.destroy(error);
              if (config.all) {
                if (address.length !== 1) throw new TypeError("lookup must pin one address");
                family = address[0].family;
                address = address[0].address;
              }
              attempts.push({ address, family });
              authorities.push({ host: options.headers.host, servername: options.servername, agent: options.agent });
              const outcome = config.outcomes[attempts.length - 1];
              if (outcome === "refused") return req.destroy(new TypeError("ECONNREFUSED"));
              if (outcome === "stall") return;
              socket.emit("secureConnect");
              if (outcome === "connected-error") return req.destroy(new TypeError("response failed"));
              const complete = () => {
                options.signal.removeEventListener("abort", onAbort);
                const response = Object.assign(Readable.from(["metadata"]), {
                  statusCode: outcome === "redirect" ? 302 : 200,
                  statusMessage: "fixture response",
                  headers: { "content-type": "application/json", location: "https://other.example.test/metadata" },
                });
                respond(response);
              };
              if (outcome === "slow-response") responseTimer = setTimeout(complete, 1100);
              else complete();
            });
          });
        };
        return req;
      },
    }));
    const { fetchClientMetadataResource } = await import("@better-auth/cimd/node");
    const started = performance.now();
    const timer = setTimeout(abort, config.timeoutMs ?? 4000);
    let result;
    try {
      const response = await fetchClientMetadataResource("https://client.example.test:8443/metadata", {
        signal: controller.signal,
      });
      result = { status: response.status, body: await response.text() };
    } catch (error) {
      result = { error: error.message, name: error.name };
    } finally {
      clearTimeout(timer);
    }
    console.log(${JSON.stringify(PROBE_RESULT_PREFIX)} + JSON.stringify({ ...result, attempts, authorities, resolutions, elapsedMs: performance.now() - started }));
    });
  `;
  const cwd = new URL("../../../../..", import.meta.url).pathname;
  const directory = await mkdtemp(path.join(cwd, ".cimd-transport-"));
  try {
    const fixture = path.join(directory, "probe.test.mjs");
    await Bun.write(fixture, script);
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", "test", fixture],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const results = stdout
      .split("\n")
      .filter((line) => line.startsWith(PROBE_RESULT_PREFIX));
    expect(results, stdout).toHaveLength(1);
    return JSON.parse(results.join("").slice(PROBE_RESULT_PREFIX.length));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("CIMD connections use only vetted addresses within one fetch budget", () => {
  test.each([false, true])(
    "fails over from refused IPv6 to IPv4 (lookup all=%s)",
    async (all) => {
      const result = await probe({
        addresses,
        outcomes: ["refused", "success"],
        all,
      });
      expect(result).toMatchObject({
        status: 200,
        body: "metadata",
        resolutions: 1,
        attempts: addresses,
      });
      expect(result.authorities).toEqual(
        addresses.map(() => ({
          host: "client.example.test:8443",
          servername: "client.example.test",
          agent: false,
        })),
      );
    },
  );

  test("alternates families and tries every candidate until one connects", async () => {
    const secondIpv6 = { address: "2606:4700:4700::1001", family: 6 };
    const result = await probe({
      addresses: [ipv6Address, secondIpv6, ipv4Address],
      outcomes: ["refused", "refused", "success"],
    });
    expect(result).toMatchObject({
      status: 200,
      resolutions: 1,
      attempts: [ipv6Address, ipv4Address, secondIpv6],
    });
  });

  test.each(["10.0.0.1", "127.0.0.1", "::1", "fc00::1"])(
    "rejects the entire DNS answer set containing %s before connecting",
    async (address) => {
      const result = await probe({
        addresses: [
          ...addresses,
          { address, family: address.includes(":") ? 6 : 4 },
        ],
        outcomes: ["success"],
      });
      expect(result).toMatchObject({
        error:
          "metadata hostname must resolve only to public-routable addresses",
        resolutions: 1,
        attempts: [],
      });
    },
  );

  test("moves past a stalled connection within its attempt budget", async () => {
    const result = await probe({ addresses, outcomes: ["stall", "success"] });
    expect(result).toMatchObject({
      status: 200,
      attempts: addresses,
      resolutions: 1,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(result.elapsedMs).toBeLessThan(2500);
  });

  test("the overall deadline ends all attempts without restarting the budget", async () => {
    const result = await probe({
      addresses: [...addresses, { address: "8.8.8.8", family: 4 }],
      outcomes: ["stall", "stall", "success"],
      timeoutMs: 1300,
    });
    expect(result).toMatchObject({
      error: "overall deadline",
      name: "TimeoutError",
      attempts: addresses,
      resolutions: 1,
    });
    expect(result.elapsedMs).toBeLessThan(2300);
  });

  test("the overall deadline also bounds DNS resolution", async () => {
    const result = await probe({
      addresses,
      outcomes: [],
      stallDns: true,
      timeoutMs: 30,
    });
    expect(result).toMatchObject({
      error: "overall deadline",
      attempts: [],
      resolutions: 1,
    });
  });

  test("an already expired deadline performs no DNS lookup or connection", async () => {
    const result = await probe({ addresses, outcomes: [], preAborted: true });
    expect(result).toMatchObject({
      error: "overall deadline",
      attempts: [],
      resolutions: 0,
    });
  });

  test.each(["connected-error", "redirect", "slow-response"] as const)(
    "stops connection retries after TLS succeeds (%s)",
    async (outcome) => {
      const result = await probe({ addresses, outcomes: [outcome, "success"] });
      expect(result.attempts).toEqual([ipv6Address]);
      if (outcome === "connected-error") {
        expect(result.error).toBe("response failed");
      } else {
        expect(result.status).toBe(outcome === "redirect" ? 302 : 200);
      }
    },
  );

  test("surfaces the final connection failure when all candidates fail", async () => {
    const result = await probe({ addresses, outcomes: ["refused", "refused"] });
    expect(result).toMatchObject({
      error: "ECONNREFUSED",
      attempts: addresses,
      resolutions: 1,
    });
  });
});
