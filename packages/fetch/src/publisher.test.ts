import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createPolitePublisherFetch,
  evaluatePublisherRobots,
} from "./publisher";

describe("RFC 9309 matching", () => {
  test("the most specific, case-insensitive product-token group wins over wildcard", () => {
    assertProperty(
      "named-group-selection",
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

  test("longest matching rule wins and Allow wins equal specificity", () => {
    assertProperty(
      "longest-rule-match",
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

  test("wildcards and end anchors apply to the path plus query", () => {
    assertProperty(
      "wildcard-anchor-match",
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
      "percent-encoding-match",
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
});

describe("publisher scheduler", () => {
  test("serializes concurrent callers and waits for Crawl-delay", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const requestedAt: number[] = [];
    const request = createPolitePublisherFetch({
      clock: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/robots.txt") {
          // oxlint-disable-next-line stella-lowercase/stella-lowercase -- Fixture exercises the registered HTTP product token.
          return new Response("User-agent: Stella\nCrawl-delay: 2\nAllow: /");
        }
        requestedAt.push(now);
        return new Response("ok");
      },
    });
    const options = {
      userAgent: "Stella/1.0 (+https://stella.law)",
      enforcement: "enforce" as const,
    };
    const outcomes = await Promise.all([
      request("https://publisher.example/one", options),
      request("https://publisher.example/two", options),
      request("https://publisher.example/three", options),
    ]);
    expect(outcomes.every((outcome) => outcome.isOk())).toBe(true);
    expect(requestedAt).toEqual([0, 2000, 4000]);
    expect(sleeps).toEqual([2000, 2000]);
  });

  test("follows robots redirects before evaluating the original origin", async () => {
    const requested: string[] = [];
    const request = createPolitePublisherFetch({
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
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

    const outcome = await request("https://publisher.example/private/case", {
      userAgent: "Stella/1.0 (+https://stella.law)",
      enforcement: "enforce",
    });

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
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
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

    const outcome = await request("https://publisher.example/public", {
      userAgent: "Stella/1.0 (+https://stella.law)",
      enforcement: "enforce",
    });

    expect(outcome.isErr()).toBe(true);
    expect(fetchedResources).toEqual(["/public"]);
  });

  test("applies destination robots rules and scheduling across origins", async () => {
    let now = 0;
    const resourceRequests: { host: string; time: number }[] = [];
    const request = createPolitePublisherFetch({
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
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
    const options = {
      userAgent: "Stella/1.0 (+https://stella.law)",
      enforcement: "enforce" as const,
    };

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

  test("returns a typed refusal when redirects exceed the bound", async () => {
    const request = createPolitePublisherFetch({
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/robots.txt") {
          return new Response(null, { status: 404 });
        }
        return Response.redirect(
          new URL(
            `/loop/${Number(url.pathname.split("/").at(-1) ?? 0) + 1}`,
            url,
          ),
          302,
        );
      },
      defaultMinimumIntervalMs: 0,
    });

    const outcome = await request("https://publisher.example/loop/0", {
      userAgent: "Stella/1.0 (+https://stella.law)",
      enforcement: "enforce",
    });

    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error._tag).toBe("publisher_redirect_limit");
    }
  });

  test("reloads robots after a stream failure and retry interval", async () => {
    let now = 0;
    let robotsRequests = 0;
    const request = createPolitePublisherFetch({
      clock: { now: () => now, sleep: async () => undefined },
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
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
    const options = {
      userAgent: "Stella/1.0 (+https://stella.law)",
      enforcement: "enforce" as const,
    };

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
      const request = createPolitePublisherFetch({
        fetcher: async (input) =>
          new URL(input instanceof Request ? input.url : input).pathname ===
          "/robots.txt"
            ? new Response(null, { status })
            : new Response("ok"),
        defaultMinimumIntervalMs: 0,
      });
      const outcome = await request("https://publisher.example/case", {
        userAgent: "Stella/1.0 (+https://stella.law)",
        enforcement: "enforce",
      });
      expect(outcome.isOk()).toBe(allowed);
      if (!allowed && outcome.isErr()) {
        expect(outcome.error._tag).toBe("robots_unavailable");
      }
    }
  });
});
