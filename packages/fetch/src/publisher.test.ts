import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createPolitePublisherFetch,
  evaluatePublisherRobots,
  readBoundedBody,
} from "./publisher";
import type { PublisherBypassableRefusal } from "./publisher";

describe("RFC 9309 matching", () => {
  test("linear wildcard matching agrees with a dynamic-programming reference", () => {
    const reference = (pattern: string, path: string) => {
      const anchored = pattern.endsWith("$");
      const source = anchored ? pattern.slice(0, -1) : pattern;
      const memo = new Map<string, boolean>();
      const match = (patternIndex: number, pathIndex: number): boolean => {
        const key = `${patternIndex}:${pathIndex}`;
        const cached = memo.get(key);
        if (cached !== undefined) {
          return cached;
        }
        let result: boolean;
        if (patternIndex === source.length) {
          result = !anchored || pathIndex === path.length;
        } else if (source[patternIndex] === "*") {
          result =
            match(patternIndex + 1, pathIndex) ||
            (pathIndex < path.length && match(patternIndex, pathIndex + 1));
        } else {
          result =
            pathIndex < path.length &&
            source[patternIndex] === path[pathIndex] &&
            match(patternIndex + 1, pathIndex + 1);
        }
        memo.set(key, result);
        return result;
      };
      return match(0, 0);
    };
    assertProperty(
      "linear wildcard matching agrees with a dynamic-programming reference",
      fc.property(
        fc.stringMatching(/^[ab*]{0,12}\$?$/u),
        fc.stringMatching(/^[ab]{0,12}$/u),
        (pattern, path) => {
          const result = evaluatePublisherRobots(
            [{ agents: ["*"], rules: [{ type: "disallow", pattern }] }],
            "Stella",
            path,
          );
          expect(result.allowed).toBe(!reference(pattern, path));
        },
      ),
    );
  });

  test.each([
    ["*a", "ab", true],
    ["/*a", "/abc", true],
    ["/*a$", "/abc", false],
    ["/*a$", "/cba", true],
    ["/**a", "/abc", true],
    ["/a**b$", "/ab", true],
  ] as const)(
    "matches %s against %s with RFC prefix semantics",
    (pattern, path, matches) => {
      const result = evaluatePublisherRobots(
        [{ agents: ["*"], rules: [{ type: "disallow", pattern }] }],
        "Stella",
        path,
      );
      expect(result.allowed, `${pattern} against ${path}`).toBe(!matches);
    },
  );

  test("long literal suffixes are matched without rescanning", () => {
    const pattern = `/*${"a".repeat(100_000)}b$`;
    expect(
      evaluatePublisherRobots(
        [{ agents: ["*"], rules: [{ type: "disallow", pattern }] }],
        "Stella",
        `/${"a".repeat(200_000)}`,
      ).allowed,
    ).toBe(true);
  });

  test("a case-insensitive product-token group wins over wildcard", () => {
    assertProperty(
      "a case-insensitive product-token group wins over wildcard",
      fc.property(
        fc.array(fc.constantFrom("Stella", "STELLA", "stella"), {
          minLength: 1,
        }),
        (agents) => {
          const groups = [
            {
              agents: ["*"],
              rules: [{ type: "allow" as const, pattern: "/" }],
            },
            ...agents.map((agent) => ({
              agents: [agent.toLowerCase()],
              rules: [{ type: "disallow" as const, pattern: "/" }],
            })),
          ];
          const result = evaluatePublisherRobots(groups, "Stella", "/case");
          expect(result.allowed).toBe(false);
          expect(result.agentExcluded).toBe(true);
        },
      ),
    );
  });

  test("a group for a different product token never matches", () => {
    assertProperty(
      "a group for a different product token never matches",
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 5 }).map((end) => "stella".slice(0, end)),
          fc.stringMatching(/^[a-z]{1,8}$/u).map((suffix) => `stella${suffix}`),
        ),
        (agent) => {
          const result = evaluatePublisherRobots(
            [
              {
                agents: [agent],
                rules: [{ type: "allow", pattern: "/" }],
              },
              {
                agents: ["*"],
                rules: [{ type: "disallow", pattern: "/" }],
              },
            ],
            "Stella",
            "/case",
          );
          expect(result.allowed).toBe(false);
        },
      ),
    );
  });

  test("longest matching rule wins and Allow wins equal specificity", () => {
    assertProperty(
      "longest matching rule wins and Allow wins equal specificity",
      fc.property(fc.stringMatching(/^[a-z]{1,12}$/u), (suffix) => {
        const result = evaluatePublisherRobots(
          [
            {
              agents: ["stella"],
              rules: [
                { type: "disallow", pattern: "/documents/*" },
                { type: "allow", pattern: `/documents/${suffix}$` },
              ],
            },
          ],
          "Stella",
          `/documents/${suffix}`,
        );
        expect(result.allowed).toBe(true);
      }),
    );
  });

  test("a wildcard counts toward rule specificity", () => {
    // "/*.htm" is six octets as written and outranks the five-octet "/page".
    const groups = [
      {
        agents: ["stella"],
        rules: [
          { type: "allow" as const, pattern: "/page" },
          { type: "disallow" as const, pattern: "/*.htm" },
        ],
      },
    ];
    expect(evaluatePublisherRobots(groups, "Stella", "/page.htm").allowed).toBe(
      false,
    );
    expect(evaluatePublisherRobots(groups, "Stella", "/page").allowed).toBe(
      true,
    );
  });

  test("wildcards and end anchors apply to the path plus query", () => {
    assertProperty(
      "wildcards and end anchors apply to the path plus query",
      fc.property(fc.stringMatching(/^[a-z]{1,12}$/u), (value) => {
        const groups = [
          {
            agents: ["stella"],
            rules: [
              { type: "disallow" as const, pattern: "/search?*private$" },
            ],
          },
        ];
        expect(
          evaluatePublisherRobots(groups, "Stella", `/search?q=${value}private`)
            .allowed,
        ).toBe(false);
        expect(
          evaluatePublisherRobots(
            groups,
            "Stella",
            `/search?q=${value}private-more`,
          ).allowed,
        ).toBe(true);
      }),
    );
  });

  test("percent-encoded unreserved octets compare as their decoded form", () => {
    assertProperty(
      "percent-encoded unreserved octets compare as their decoded form",
      fc.property(
        fc.constantFrom("41", "42", "43", "61", "62", "63"),
        (hex) => {
          const character = String.fromCodePoint(Number.parseInt(hex, 16));
          const groups = [
            {
              agents: ["stella"],
              rules: [
                { type: "disallow" as const, pattern: `/case/${character}` },
              ],
            },
          ];
          expect(
            evaluatePublisherRobots(groups, "Stella", `/case/%${hex}`).allowed,
          ).toBe(false);
        },
      ),
    );
  });

  test("literal Unicode and encoded UTF-8 paths compare as the same octets", () => {
    const groups = [
      {
        agents: ["stella"],
        rules: [{ type: "disallow" as const, pattern: "/café" }],
      },
    ];
    expect(evaluatePublisherRobots(groups, "Stella", "/café").allowed).toBe(
      false,
    );
    expect(
      evaluatePublisherRobots(groups, "Stella", "/caf%C3%A9").allowed,
    ).toBe(false);
  });

  test.each(["/é*", "/%C3%A9*"])(
    "rule specificity counts an encoded octet once (Allow %s)",
    (allow) => {
      // "/é" is three octets, so the five-octet Disallow is more specific.
      const groups = [
        {
          agents: ["stella"],
          rules: [
            { type: "allow" as const, pattern: allow },
            { type: "disallow" as const, pattern: "/*abcd" },
          ],
        },
      ];
      expect(evaluatePublisherRobots(groups, "Stella", "/éabcd").allowed).toBe(
        false,
      );
    },
  );
});

describe("publisher scheduler", () => {
  const allowTarget = async (url: URL) => Result.ok({ url });

  test("transports only validator-produced targets for robots, resources, and redirects", async () => {
    const produced = new Set<object>();
    const validatedUrls: string[] = [];
    const fetchedUrls: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: async (url) => {
        const target = { url, validation: Symbol(url.href) };
        produced.add(target);
        validatedUrls.push(url.href);
        return Result.ok(target);
      },
      fetcher: async (target) => {
        expect(produced.has(target)).toBe(true);
        produced.delete(target);
        fetchedUrls.push(target.url.href);
        if (target.url.href === "https://publisher.example/robots.txt") {
          return Response.redirect("https://policy.example/robots.txt", 302);
        }
        if (target.url.href === "https://policy.example/robots.txt") {
          return new Response("User-agent: *\nAllow: /");
        }
        if (target.url.href === "https://publisher.example/start") {
          return Response.redirect("https://publisher.example/final", 302);
        }
        return new Response("ok");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/start");

    expect(outcome.isOk()).toBe(true);
    expect(fetchedUrls.toSorted()).toEqual(validatedUrls.toSorted());
    expect(fetchedUrls).toEqual([
      "https://publisher.example/robots.txt",
      "https://policy.example/robots.txt",
      "https://publisher.example/start",
      "https://publisher.example/final",
    ]);
    expect(produced.size).toBe(0);
  });

  test("serializes concurrent callers and waits for Crawl-delay", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const requestedAt: number[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          await Promise.resolve();
          now += ms;
        },
      },
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          // oxlint-disable-next-line stella-lowercase/stella-lowercase -- Fixture exercises the registered HTTP product token.
          return new Response("User-agent: Stella\nCrawl-delay: 2\nAllow: /");
        }
        requestedAt.push(now);
        return new Response("ok");
      },
    });
    const options = {};
    const outcomes = await Promise.all([
      request("https://publisher.example/one", options),
      request("https://publisher.example/two", options),
      request("https://publisher.example/three", options),
    ]);
    expect(outcomes.every((outcome) => outcome.isOk())).toBe(true);
    expect(requestedAt).toHaveLength(3);
    expect(requestedAt.at(0)).toBe(0);
    expect(sleeps).toEqual([2000, 2000]);
  });

  test("preserves a caller-provided transport timeout", async () => {
    const seen: unknown[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      defaultMinimumIntervalMs: 0,
      fetcher: async (input, init) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        seen.push(init?.timeout);
        return new Response("ok");
      },
    });
    await request("https://publisher.example/case", {
      init: { timeout: { type: "idle", ms: 321 } },
    });
    expect(seen).toEqual([{ type: "idle", ms: 321 }]);
  });

  test("refuses crawl delays above the maximum", async () => {
    let resources = 0;
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response("User-agent: *\nCrawl-delay: 61\nAllow: /");
        }
        resources += 1;
        return new Response("ok");
      },
    });
    const outcome = await request("https://publisher.example/case");
    expect(outcome.isErr() && outcome.error._tag).toBe(
      "crawl_delay_unsupported",
    );
    expect(resources).toBe(0);
  });

  test("sends the agent robots rules were evaluated for, whatever the caller headers say", async () => {
    const agents: (string | null)[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input, init) => {
        const url = input.url;
        agents.push(new Headers(init?.headers).get("user-agent"));
        if (url.pathname === "/robots.txt") {
          return new Response(
            // oxlint-disable-next-line stella-lowercase/stella-lowercase -- Fixture exercises the registered HTTP product token.
            "User-agent: Stella\nDisallow: /private\nUser-agent: *\nAllow: /",
          );
        }
        return new Response("ok");
      },
      defaultMinimumIntervalMs: 0,
    });

    const refused = await request("https://publisher.example/private/case", {
      init: { headers: { "User-Agent": "Other/1.0" } },
    });
    const allowed = await request("https://publisher.example/public", {
      init: { headers: { "User-Agent": "Other/1.0" } },
    });

    expect(Result.isError(refused) && refused.error._tag).toBe(
      "robots_disallowed",
    );
    expect(allowed.isOk()).toBe(true);
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent?.split("/").at(0)).toBe(agents.at(0)?.split("/").at(0));
      expect(agent).not.toContain("Other");
    }
  });

  test("a licensed policy does not authorize a redirect to another origin", async () => {
    const requested: string[] = [];
    const bypasses: unknown[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      onTelemetry: (event) => {
        bypasses.push(event.origin);
      },
      fetcher: async (input) => {
        const url = input.url;
        requested.push(url.href);
        if (url.pathname === "/robots.txt") {
          return new Response("User-agent: *\nDisallow: /");
        }
        return url.hostname === "source.example"
          ? Response.redirect("https://destination.example/case", 302)
          : new Response("unexpected resource fetch");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://source.example/case", {
      policy: {
        type: "licensed",
        basis: "publisher agreement",
        evidenceUrl: "https://source.example/license",
      },
    });

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "robots_disallowed",
    );
    expect(bypasses).toEqual(["https://source.example"]);
    expect(requested).toEqual([
      "https://source.example/robots.txt",
      "https://source.example/case",
      "https://destination.example/robots.txt",
    ]);
  });

  test("bounded body reads refuse oversized bodies and cancel the stream", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel: () => {
          cancelled = true;
        },
      }),
    );
    const read = await readBoundedBody(response, {
      maxBytes: 4096,
      signal: AbortSignal.timeout(5000),
    });
    expect(Result.isError(read) && read.error._tag).toBe(
      "publisher_body_limit",
    );
    expect(cancelled).toBe(true);
  });

  const trackLiveListeners = (signal: AbortSignal) => {
    const live = { added: 0, count: 0 };
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      live.added += 1;
      live.count += 1;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      live.count -= 1;
      remove(...args);
    };
    return live;
  };

  test("bounded body reads retain no abort listener however many chunks arrive", async () => {
    const { signal } = new AbortController();
    const live = trackLiveListeners(signal);
    let chunks = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: (stream) => {
          if (chunks === 1000) {
            stream.close();
            return;
          }
          chunks += 1;
          stream.enqueue(new Uint8Array(1));
        },
      }),
    );

    const read = await readBoundedBody(response, { maxBytes: 4096, signal });

    expect(Result.isOk(read) && read.value.byteLength).toBe(1000);
    expect(live.added).toBeGreaterThan(0);
    expect(live.count).toBe(0);
  });

  test("successful requests sharing one caller signal retain no abort listener", async () => {
    const { signal } = new AbortController();
    const live = trackLiveListeners(signal);
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        const url = input.url;
        return url.pathname === "/robots.txt"
          ? new Response(null, { status: 404 })
          : new Response("ok");
      },
      defaultMinimumIntervalMs: 0,
    });

    for (const path of ["/a", "/b", "/c"]) {
      const outcome = await request(`https://publisher.example${path}`, {
        init: { signal },
      });
      expect(Result.isOk(outcome)).toBe(true);
    }

    expect(live.added).toBeGreaterThan(0);
    expect(live.count).toBe(0);
  });

  test.each([300, 304])(
    "returns a %d response carrying Location without following it",
    async (status) => {
      const requested: string[] = [];
      const request = createPolitePublisherFetch({
        validateTarget: allowTarget,
        fetcher: async (input) => {
          const url = input.url;
          requested.push(url.href);
          if (url.pathname === "/robots.txt") {
            return new Response(null, { status: 404 });
          }
          return new Response(null, {
            status,
            headers: { location: "https://publisher.example/elsewhere" },
          });
        },
        defaultMinimumIntervalMs: 0,
      });

      const outcome = await request("https://publisher.example/case");

      expect(Result.isOk(outcome) && outcome.value.response.status).toBe(
        status,
      );
      expect(requested).toEqual([
        "https://publisher.example/robots.txt",
        "https://publisher.example/case",
      ]);
    },
  );

  test("bounded body reads reject a stalled body at the deadline", async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    const read = await Result.tryPromise(async () =>
      readBoundedBody(response, {
        maxBytes: 4096,
        signal: AbortSignal.timeout(20),
      }),
    );
    expect(Result.isError(read)).toBe(true);
  });

  test("a group holding only Crawl-delay ends before the next User-agent", async () => {
    let resources = 0;
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response(
            "User-agent: *\nCrawl-delay: 61\nUser-agent: stella\nAllow: /",
          );
        }
        resources += 1;
        return new Response("ok");
      },
    });
    const outcome = await request("https://publisher.example/case");
    expect(outcome.isOk()).toBe(true);
    expect(resources).toBe(1);
  });

  // Total over the bypassable refusals: a new kind cannot land without a case.
  const BYPASS_CASES = {
    robots_disallowed: () => new Response("User-agent: *\nDisallow: /"),
    agent_excluded: () => new Response("User-agent: stella\nDisallow: /"),
    crawl_delay_unsupported: () =>
      new Response("User-agent: *\nCrawl-delay: 3600"),
    robots_unavailable: () => new Response("unavailable", { status: 503 }),
  } as const satisfies Record<
    PublisherBypassableRefusal["_tag"],
    () => Response
  >;
  const licensedPolicy = {
    type: "licensed" as const,
    basis: "publisher agreement",
    evidenceUrl: "https://publisher.example/license",
  };

  test.each(Object.entries(BYPASS_CASES))(
    "every licensed bypass of %s requires an awaited audit record",
    async (tag, robots) => {
      const sinks = {
        missing: undefined,
        rejecting: async () => {
          await Promise.resolve();
          throw new Error("audit store unavailable");
        },
      };
      for (const [name, onTelemetry] of Object.entries(sinks)) {
        const requested: string[] = [];
        const request = createPolitePublisherFetch({
          validateTarget: allowTarget,
          clock: { now: () => 0, sleep: async () => undefined },
          ...(onTelemetry === undefined ? {} : { onTelemetry }),
          fetcher: async (input) => {
            requested.push(input.url.pathname);
            return input.url.pathname === "/robots.txt"
              ? robots()
              : new Response("licensed document");
          },
          defaultMinimumIntervalMs: 0,
        });
        const outcome = await request("https://publisher.example/one", {
          policy: licensedPolicy,
        });
        expect({
          name,
          tag: Result.isError(outcome) && outcome.error._tag,
        }).toEqual({
          name,
          tag: "publisher_bypass_unaudited",
        });
        expect({ name, requested }).toEqual({
          name,
          requested: ["/robots.txt"],
        });
      }

      const recorded: string[] = [];
      const requested: string[] = [];
      const request = createPolitePublisherFetch({
        validateTarget: allowTarget,
        clock: { now: () => 0, sleep: async () => undefined },
        onTelemetry: async (event) => {
          await Promise.resolve();
          recorded.push(event.refusal._tag);
        },
        fetcher: async (input) => {
          requested.push(input.url.pathname);
          return input.url.pathname === "/robots.txt"
            ? robots()
            : new Response("licensed document");
        },
        defaultMinimumIntervalMs: 0,
      });
      const outcome = await request("https://publisher.example/one", {
        policy: licensedPolicy,
      });
      expect(outcome.isOk() && outcome.value.robotsDecision).toBe(
        "licensed_bypass",
      );
      expect(recorded).toEqual([tag]);
      expect(requested).toEqual(["/robots.txt", "/one"]);
    },
  );

  test("a CR-only robots.txt still refuses a disallowed resource", async () => {
    const requested: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        requested.push(input.url.href);
        return input.url.pathname === "/robots.txt"
          ? new Response("User-agent: *\rDisallow: /")
          : new Response("resource");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/one");

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "robots_disallowed",
    );
    expect(requested).toEqual(["https://publisher.example/robots.txt"]);
  });

  test("a licensed bypass without an audit sink is refused before the resource is fetched", async () => {
    const requested: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        requested.push(input.url.href);
        return input.url.pathname === "/robots.txt"
          ? new Response("User-agent: *\nDisallow: /")
          : new Response("licensed document");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/one", {
      policy: {
        type: "licensed",
        basis: "publisher agreement",
        evidenceUrl: "https://publisher.example/license",
      },
    });

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "publisher_bypass_unaudited",
    );
    expect(requested).toEqual(["https://publisher.example/robots.txt"]);
  });

  test("a licensed bypass whose recording fails is refused before the resource is fetched", async () => {
    const requested: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      onTelemetry: async () => {
        await Promise.resolve();
        throw new Error("audit store unavailable");
      },
      fetcher: async (input) => {
        requested.push(input.url.href);
        return input.url.pathname === "/robots.txt"
          ? new Response("User-agent: *\nDisallow: /")
          : new Response("licensed document");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/one", {
      policy: {
        type: "licensed",
        basis: "publisher agreement",
        evidenceUrl: "https://publisher.example/license",
      },
    });

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "publisher_bypass_unaudited",
    );
    expect(requested).toEqual(["https://publisher.example/robots.txt"]);
  });

  test("aborting a stalled licensed bypass recording returns a typed refusal promptly", async () => {
    const controller = new AbortController();
    let markRecordingStarted!: () => void;
    const recordingStarted = new Promise<void>((resolve) => {
      markRecordingStarted = resolve;
    });
    let resourceFetches = 0;
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      onTelemetry: async () => {
        markRecordingStarted();
        await new Promise<never>(() => {});
      },
      fetcher: async (input) => {
        if (input.url.pathname === "/robots.txt") {
          return new Response("User-agent: *\nDisallow: /");
        }
        resourceFetches += 1;
        return new Response("licensed document");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcomePromise = request("https://publisher.example/one", {
      init: { signal: controller.signal },
      policy: licensedPolicy,
    });
    await recordingStarted;
    controller.abort();
    const outcome = await outcomePromise;

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "publisher_request_aborted",
    );
    expect(resourceFetches).toBe(0);
  }, 1000);

  test("licensed sources record their basis and cap unsupported delays", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const policies: unknown[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
      onTelemetry: ({ policy }) => {
        policies.push(policy);
      },
      fetcher: async (input) =>
        input.url.pathname === "/robots.txt"
          ? new Response("User-agent: *\nCrawl-delay: 3600\nDisallow: /")
          : new Response("licensed document"),
    });
    const options = {
      policy: {
        type: "licensed" as const,
        basis: "publisher agreement",
        evidenceUrl: "https://publisher.example/license",
      },
    };

    const first = await request("https://publisher.example/one", options);
    const second = await request("https://publisher.example/two", options);

    expect(first.isOk() && first.value.robotsDecision).toBe("licensed_bypass");
    expect(second.isOk() && second.value.delayAppliedMs).toBe(60_000);
    expect(sleeps).toEqual([60_000]);
    expect(policies).toEqual([options.policy, options.policy]);
  });

  test("aborting a scheduled wait returns a typed refusal promptly", async () => {
    let now = 0;
    const controller = new AbortController();
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: {
        now: () => now,
        sleep: async (_ms, signal) => {
          markSleepStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
      },
      fetcher: async (input) =>
        input.url.pathname === "/robots.txt"
          ? new Response("User-agent: *\nCrawl-delay: 1\nAllow: /")
          : new Response("ok"),
    });
    const options = {};
    await request("https://publisher.example/one", options);
    now = 1;
    const pending = request("https://publisher.example/two", {
      ...options,
      init: { signal: controller.signal },
    });
    await sleepStarted;
    controller.abort();
    const outcome = await pending;
    expect(outcome.isErr() && outcome.error._tag).toBe(
      "publisher_request_aborted",
    );
  });

  test("aborting a wait on a signal-ignoring sleep releases the origin queue", async () => {
    let now = 0;
    let sleepCalls = 0;
    const controller = new AbortController();
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            markSleepStarted();
            await new Promise<never>(() => {
              // Ignores its signal and never settles.
            });
          }
          now += ms;
        },
      },
      fetcher: async (input) =>
        input.url.pathname === "/robots.txt"
          ? new Response("User-agent: *\nCrawl-delay: 1\nAllow: /")
          : new Response("ok"),
    });
    const options = {};
    await request("https://publisher.example/one", options);
    now = 1;
    const stalled = request("https://publisher.example/two", {
      ...options,
      init: { signal: controller.signal },
    });
    await sleepStarted;
    controller.abort();
    const aborted = await stalled;
    expect(aborted.isErr() && aborted.error._tag).toBe(
      "publisher_request_aborted",
    );

    const next = await request("https://publisher.example/three", options);

    expect(next.isOk()).toBe(true);
    expect(sleepCalls).toBe(2);
  });

  test("an aborted queued caller does not wait or consume a schedule slot", async () => {
    let now = 0;
    const sleeps: { ms: number; finish: () => void }[] = [];
    let markFirstSleep!: () => void;
    let markSecondSleep!: () => void;
    const firstSleep = new Promise<void>((resolve) => {
      markFirstSleep = resolve;
    });
    const secondSleep = new Promise<void>((resolve) => {
      markSecondSleep = resolve;
    });
    const requestedAt: { path: string; at: number }[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          await new Promise<void>((resolve) => {
            sleeps.push({
              ms,
              finish: () => {
                now += ms;
                resolve();
              },
            });
            if (sleeps.length === 1) {
              markFirstSleep();
            } else {
              markSecondSleep();
            }
          });
        },
      },
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response("User-agent: *\nCrawl-delay: 1\nAllow: /");
        }
        requestedAt.push({ path: url.pathname, at: now });
        return new Response("ok");
      },
    });
    const options = {};
    await request("https://publisher.example/one", options);
    const second = request("https://publisher.example/two", options);
    await firstSleep;
    const controller = new AbortController();
    const third = request("https://publisher.example/three", {
      ...options,
      init: { signal: controller.signal },
    });
    const fourth = request("https://publisher.example/four", options);
    controller.abort();

    const aborted = await third;
    expect(aborted.isErr() && aborted.error._tag).toBe(
      "publisher_request_aborted",
    );
    expect(requestedAt.map(({ path }) => path)).toEqual(["/one"]);

    sleeps[0]!.finish();
    await second;
    await secondSleep;
    expect(sleeps.map(({ ms }) => ms)).toEqual([1000, 1000]);
    sleeps[1]!.finish();
    await fourth;
    expect(requestedAt).toEqual([
      { path: "/one", at: 0 },
      { path: "/two", at: 1000 },
      { path: "/four", at: 2000 },
    ]);
  });

  test("a robots body that never ends expires as unavailable", async () => {
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      robotsLoadTimeoutMs: 5,
      fetcher: async () => new Response(new ReadableStream({ pull() {} })),
    });
    const outcome = await request("https://publisher.example/case");
    expect(outcome.isErr() && outcome.error._tag).toBe("robots_unavailable");
  });

  test("a robots validator that never settles expires as unavailable", async () => {
    const request = createPolitePublisherFetch({
      validateTarget: async (url) =>
        url.pathname === "/robots.txt"
          ? await new Promise<never>(() => {})
          : Result.ok({ url }),
      robotsLoadTimeoutMs: 5,
      fetcher: async () => new Response("unexpected request"),
    });
    const outcome = await request("https://publisher.example/case");
    expect(outcome.isErr() && outcome.error._tag).toBe("robots_unavailable");
  });

  test("a robots transport that ignores its signal expires as unavailable", async () => {
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      robotsLoadTimeoutMs: 5,
      fetcher: async () => await new Promise<never>(() => {}),
    });
    const outcome = await request("https://publisher.example/case");
    expect(outcome.isErr() && outcome.error._tag).toBe("robots_unavailable");
  });

  test("follows robots redirects before evaluating the original origin", async () => {
    const requested: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        const url = input.url;
        requested.push(url.href);
        if (url.pathname === "/robots.txt") {
          return Response.redirect("https://policy.example/rules.txt", 301);
        }
        if (url.hostname === "policy.example") {
          // oxlint-disable-next-line stella-lowercase/stella-lowercase -- Fixture exercises the registered HTTP product token.
          return new Response("User-agent: Stella\nDisallow: /private");
        }
        return new Response("unexpected resource fetch");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/private/case");

    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error._tag).toBe("robots_disallowed");
    }
    expect(requested).toEqual([
      "https://publisher.example/robots.txt",
      "https://policy.example/rules.txt",
    ]);
  });

  test("refuses a same-origin redirect to a disallowed path", async () => {
    const fetchedResources: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input, init) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          // oxlint-disable-next-line stella-lowercase/stella-lowercase -- Fixture exercises the registered HTTP product token.
          return new Response("User-agent: Stella\nDisallow: /private");
        }
        fetchedResources.push(url.pathname);
        if (url.pathname === "/public" && init?.redirect !== "manual") {
          fetchedResources.push("/private");
          return new Response("secret");
        }
        return url.pathname === "/public"
          ? Response.redirect("https://publisher.example/private", 302)
          : new Response("secret");
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/public");

    expect(outcome.isErr()).toBe(true);
    expect(fetchedResources).toEqual(["/public"]);
  });

  test("applies destination robots rules and scheduling across origins", async () => {
    let now = 0;
    const resourceRequests: { host: string; time: number }[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response(
            url.hostname === "destination.example"
              ? "User-agent: *\nCrawl-delay: 2\nAllow: /"
              : "User-agent: *\nAllow: /",
          );
        }
        resourceRequests.push({ host: url.hostname, time: now });
        return url.hostname === "source.example"
          ? Response.redirect("https://destination.example/first", 302)
          : new Response("ok");
      },
      defaultMinimumIntervalMs: 0,
    });
    const options = {};

    const redirected = await request("https://source.example/start", options);
    const second = await request("https://destination.example/second", options);

    expect(redirected.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(resourceRequests).toEqual([
      { host: "source.example", time: 0 },
      { host: "destination.example", time: 0 },
      { host: "destination.example", time: 2000 },
    ]);
  });

  test.each(["127.0.0.1", "10.0.0.1", "169.254.169.254"])(
    "refuses a redirect to private target %s before any request reaches it",
    async (privateHost) => {
      const requested: string[] = [];
      const request = createPolitePublisherFetch({
        validateTarget: async (url) =>
          url.hostname === privateHost
            ? Result.err(new Error("private target"))
            : Result.ok({ url }),
        fetcher: async (input) => {
          const url = input.url;
          requested.push(url.href);
          if (url.pathname === "/robots.txt") {
            return new Response(null, { status: 404 });
          }
          return Response.redirect(`http://${privateHost}/secret`, 302);
        },
        defaultMinimumIntervalMs: 0,
      });

      const outcome = await request("https://public.example/start");

      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error._tag).toBe("publisher_target_refused");
      }
      expect(requested.every((url) => !url.includes(privateHost))).toBe(true);
    },
  );

  test("refuses a private robots redirect before requesting it", async () => {
    const requested: string[] = [];
    const request = createPolitePublisherFetch({
      validateTarget: async (url) =>
        url.hostname === "127.0.0.1"
          ? Result.err(new Error("private target"))
          : Result.ok({ url }),
      fetcher: async (input) => {
        const url = input.url;
        requested.push(url.href);
        return Response.redirect("http://127.0.0.1/robots.txt", 302);
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://public.example/start");

    expect(outcome.isErr()).toBe(true);
    expect(requested).toEqual(["https://public.example/robots.txt"]);
  });

  test("strips credentials across origins and retains them on same-origin hops", async () => {
    const seen = new Map<string, Headers>();
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input, init) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        seen.set(url.href, new Headers(init?.headers));
        if (url.pathname === "/start") {
          return Response.redirect("https://source.example/next", 302);
        }
        if (url.hostname === "source.example") {
          return Response.redirect("https://destination.example/end", 302);
        }
        return new Response("ok");
      },
      defaultMinimumIntervalMs: 0,
    });

    await request("https://source.example/start", {
      init: {
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=secret",
          "Proxy-Authorization": "Basic secret",
        },
      },
    });

    expect(seen.get("https://source.example/next")?.get("authorization")).toBe(
      "Bearer secret",
    );
    const destination = seen.get("https://destination.example/end");
    expect(destination?.has("authorization")).toBe(false);
    expect(destination?.has("cookie")).toBe(false);
    expect(destination?.has("proxy-authorization")).toBe(false);
  });

  test.each([
    { status: 303, expectedMethod: "GET", expectedBody: null },
    { status: 307, expectedMethod: "POST", expectedBody: "payload" },
  ])(
    "applies fetch body semantics for POST + $status",
    async ({ status, expectedMethod, expectedBody }) => {
      let destination:
        | {
            body: BodyInit | null | undefined;
            headers: Headers;
            method: string;
          }
        | undefined;
      const request = createPolitePublisherFetch({
        validateTarget: allowTarget,
        fetcher: async (input, init) => {
          const url = input.url;
          if (url.pathname === "/robots.txt") {
            return new Response(null, { status: 404 });
          }
          if (url.pathname === "/start") {
            return Response.redirect("https://publisher.example/end", status);
          }
          destination = {
            body: init?.body,
            headers: new Headers(init?.headers),
            method: init?.method ?? "GET",
          };
          return new Response("ok");
        },
        defaultMinimumIntervalMs: 0,
      });

      const outcome = await request("https://publisher.example/start", {
        init: {
          body: "payload",
          headers: {
            "Content-Encoding": "identity",
            "Content-Type": "text/plain",
          },
          method: "POST",
        },
      });

      expect(outcome.isOk()).toBe(true);
      expect(destination?.body).toBe(expectedBody);
      expect(destination?.method).toBe(expectedMethod);
      expect(destination?.headers.has("content-type")).toBe(status === 307);
      expect(destination?.headers.has("content-encoding")).toBe(status === 307);
    },
  );

  test.each([
    [307, "POST"],
    [308, "POST"],
    [301, "PUT"],
    [302, "PATCH"],
  ] as const)(
    "refuses a %d redirect of %s when the request body cannot be replayed",
    async (status, method) => {
      let requests = 0;
      const request = createPolitePublisherFetch({
        validateTarget: allowTarget,
        fetcher: async (input) => {
          if (input.url.pathname === "/robots.txt") {
            return new Response(null, { status: 404 });
          }
          requests += 1;
          return Response.redirect("https://publisher.example/end", status);
        },
        defaultMinimumIntervalMs: 0,
      });
      const outcome = await request("https://publisher.example/start", {
        init: { body: new ReadableStream(), method },
      });

      expect(Result.isError(outcome) && outcome.error._tag).toBe(
        "publisher_body_not_replayable",
      );
      expect(requests).toBe(1);
    },
  );

  test("an aborting caller stops waiting for a shared robots load that others still use", async () => {
    let releaseRobots = () => {};
    const robotsGate = new Promise<void>((resolve) => {
      releaseRobots = resolve;
    });
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        if (input.url.pathname === "/robots.txt") {
          await robotsGate;
          return new Response(null, { status: 404 });
        }
        return new Response("ok");
      },
      robotsLoadTimeoutMs: 60_000,
      defaultMinimumIntervalMs: 0,
    });

    const aborting = request("https://publisher.example/a", {
      init: { signal: AbortSignal.timeout(20) },
    });
    const waiting = request("https://publisher.example/b");
    const aborted = await aborting;
    releaseRobots();
    const completed = await waiting;

    expect(Result.isError(aborted) && aborted.error._tag).toBe(
      "publisher_request_aborted",
    );
    expect(completed.isOk()).toBe(true);
  });

  test("aborting a stalled resource fetch returns a typed refusal promptly", async () => {
    const controller = new AbortController();
    let markResourceStarted = () => {};
    const resourceStarted = new Promise<void>((resolve) => {
      markResourceStarted = resolve;
    });
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        if (input.url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        markResourceStarted();
        return await new Promise<never>(() => {});
      },
      defaultMinimumIntervalMs: 0,
    });

    const pending = request("https://publisher.example/resource", {
      init: { signal: controller.signal },
    });
    await resourceStarted;
    controller.abort();
    const outcome = await pending;

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "publisher_request_aborted",
    );
  });

  test("a resource transport failure rejects with the original error", async () => {
    const transportError = new TypeError("fetch failed");
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        if (input.url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        throw transportError;
      },
      defaultMinimumIntervalMs: 0,
    });

    expect(
      await rejectionOf(request("https://publisher.example/resource")),
    ).toBe(transportError);
  });

  test("a non-Error transport failure rejects with an Error that keeps it", async () => {
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        if (input.url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- Fixture: a fetcher that throws a non-Error value.
        throw "socket closed";
      },
      defaultMinimumIntervalMs: 0,
    });

    const rejection = await rejectionOf(
      request("https://publisher.example/resource"),
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error && rejection.cause).toBe("socket closed");
  });

  test("a redirect body whose cancel never settles still ends at the caller deadline", async () => {
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        if (input.url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: async () => await new Promise<never>(() => {}),
          }),
          {
            status: 302,
            headers: { location: "https://publisher.example/end" },
          },
        );
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/start", {
      init: { signal: AbortSignal.timeout(20) },
    });

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "publisher_request_aborted",
    );
  });

  test("an unparsable redirect location is a typed refusal", async () => {
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) =>
        input.url.pathname === "/robots.txt"
          ? new Response(null, { status: 404 })
          : new Response(null, {
              status: 302,
              headers: { location: "http://[bad" },
            }),
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/start");

    expect(Result.isError(outcome) && outcome.error._tag).toBe(
      "publisher_target_refused",
    );
  });

  test("returns a typed refusal when redirects exceed the bound", async () => {
    let issued = 0;
    let cancelled = 0;
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        issued += 1;
        const next = new URL(
          `/loop/${Number(url.pathname.split("/").at(-1) ?? 0) + 1}`,
          url,
        );
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelled += 1;
            },
          }),
          { status: 302, headers: { location: next.href } },
        );
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/loop/0");

    expect(cancelled).toBe(issued);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error._tag).toBe("publisher_redirect_limit");
    }
  });

  test("reloads robots after a stream failure and retry interval", async () => {
    let now = 0;
    let robotsRequests = 0;
    const request = createPolitePublisherFetch({
      validateTarget: allowTarget,
      clock: { now: () => now, sleep: async () => undefined },
      fetcher: async (input) => {
        const url = input.url;
        if (url.pathname !== "/robots.txt") {
          return new Response("ok");
        }
        robotsRequests += 1;
        if (robotsRequests === 1) {
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("robots stream failed"));
              },
            }),
          );
        }
        return new Response("User-agent: *\nAllow: /");
      },
      robotsRetryMs: 10,
      defaultMinimumIntervalMs: 0,
    });
    const options = {};

    const failed = await request("https://publisher.example/case", options);
    now = 11;
    const recovered = await request("https://publisher.example/case", options);

    expect(failed.isErr()).toBe(true);
    expect(recovered.isOk()).toBe(true);
    expect(robotsRequests).toBe(2);
  });

  test("4xx permits access while 5xx is a typed refusal", async () => {
    for (const [status, allowed] of [
      [404, true],
      [503, false],
    ] as const) {
      let cancelled = false;
      const errorBody = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled = true;
        },
      });
      const request = createPolitePublisherFetch({
        validateTarget: allowTarget,
        fetcher: async (input) =>
          input.url.pathname === "/robots.txt"
            ? new Response(errorBody, { status })
            : new Response("ok"),
        defaultMinimumIntervalMs: 0,
      });
      const outcome = await request("https://publisher.example/case");
      expect(outcome.isOk()).toBe(allowed);
      expect(cancelled).toBe(true);
      if (!allowed && outcome.isErr()) {
        expect(outcome.error._tag).toBe("robots_unavailable");
      }
    }
  });
});
