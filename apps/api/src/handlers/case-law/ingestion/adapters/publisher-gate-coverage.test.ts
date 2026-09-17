import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import nodePath from "node:path";

const adaptersRoot = new URL(".", import.meta.url).pathname;

/**
 * A request that did not go through the gate is a request the publisher's
 * budget never saw, and no reviewer can spot one by reading a diff of a
 * 2,000-line adapter. So the rule is structural: under `adapters/`, only the
 * modules below may reach the network directly, and every other module has to
 * ask `fetchPublisher` or `fetchWithRetry` for the slot first.
 */
const DIRECT_FETCH_MODULES = {
  /** The gate itself: it reserves the slot, then makes the request. */
  "retry.ts": "reserve",
  /**
   * NALUS: the origin pinning and the court's limit-page redirect are this
   * module's own, and it reserves the shared slot through the policy map.
   * `cz-us-throttle.test.ts` asserts the reservation happens per request.
   */
  "cz-us-throttle.ts": "reserve",
  /** Test-only helpers, not a path any crawl takes. */
  "test-utils.ts": "test-only",
  "update-fixtures.ts": "test-only",
} as const;

/** How a module reaches the network without the gate noticing. */
const UNGATED_CALL_PATTERNS = [
  { name: "fetchWithTimeout(", pattern: /\bfetchWithTimeout\(/u },
  { name: "fetch(", pattern: /(?<![\w$.])fetch\(/u },
  { name: "globalThis.fetch", pattern: /\bglobalThis\.fetch\b/u },
  {
    name: 'import "@/api/lib/fetch"',
    pattern: /from "(?:@\/api\/lib\/fetch|@stll\/fetch)"/u,
  },
] as const;

/**
 * The module without its comments. A doc comment is free to name
 * `fetchWithTimeout`; only a call site spends a request.
 */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\n]*/gu, "");

const adapterModules = readdirSync(adaptersRoot)
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .sort();

const gatedModules = adapterModules.filter(
  (entry) => !(entry in DIRECT_FETCH_MODULES),
);

const sourceOf = async (entry: string): Promise<string> =>
  await Bun.file(nodePath.resolve(adaptersRoot, entry)).text();

const codeOf = async (entry: string): Promise<string> =>
  withoutComments(await sourceOf(entry));

describe("every publisher request goes through the gate", () => {
  test("the patterns match a module that reaches the network directly", () => {
    const ungated = [
      "const r = await fetchWithTimeout(url, { timeoutMs: 1 });",
      "await fetch(url);",
      "await globalThis.fetch(url);",
      'import { x } from "@stll/fetch";',
    ].join("\n");

    for (const { pattern } of UNGATED_CALL_PATTERNS) {
      expect(ungated).toMatch(pattern);
    }
    // The gated call must not read as one, or the sweep below proves nothing.
    expect("await fetchPublisher(url, { adapterKey })").not.toMatch(
      UNGATED_CALL_PATTERNS[1].pattern,
    );
  });

  test("the list of modules allowed to fetch directly is not stale", async () => {
    for (const entry of Object.keys(DIRECT_FETCH_MODULES)) {
      expect(adapterModules).toContain(entry);
    }

    for (const [entry, role] of Object.entries(DIRECT_FETCH_MODULES)) {
      if (role !== "reserve") {
        continue;
      }
      // A gate wrapper earns its exemption by reserving; one that stopped
      // would otherwise keep the exemption and spend nothing.
      expect(await sourceOf(entry)).toMatch(
        /createPublisherSlot|reservePublisherSlot|createPublisherRequestSlot/u,
      );
    }
  });

  test.each(gatedModules)(
    "%s reaches no publisher on its own",
    async (entry) => {
      const source = await codeOf(entry);

      for (const { name, pattern } of UNGATED_CALL_PATTERNS) {
        expect(`${entry} uses ${name}: ${pattern.test(source)}`).toBe(
          `${entry} uses ${name}: false`,
        );
      }
    },
  );
});
