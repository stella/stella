import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import nodePath from "node:path";

const caseLawRoot = nodePath.resolve(
  new URL(".", import.meta.url).pathname,
  "../..",
);

/**
 * The trees a publisher request can leave from: the crawl, the backfills and
 * repair passes beside it, and the roster import. Scanning only `adapters/`
 * left the largest walks in this slice outside the guard — a document fetch
 * and a roster read are publisher traffic whether or not a cursor drives them.
 */
const SCANNED_TREES = ["ingestion", "judges"] as const;

/**
 * A request that did not go through the gate is a request the publisher's
 * budget never saw, and no reviewer can spot one by reading a diff of a
 * 2,000-line adapter. So the rule is structural: in the trees above, only the
 * modules below may reach the network directly, and every other module has to
 * ask `fetchPublisher` or `fetchWithRetry` for the slot first.
 *
 * Paths are relative to the case-law handler root.
 */
const DIRECT_FETCH_MODULES = {
  /** The gate itself: it reserves the slot, then makes the request. */
  "ingestion/adapters/retry.ts": "reserve",
  /**
   * NALUS: the origin pinning and the court's limit-page redirect are this
   * module's own, and it reserves the shared slot through the policy map.
   * `cz-us-throttle.test.ts` asserts the reservation happens per request.
   */
  "ingestion/adapters/cz-us-throttle.ts": "reserve",
  /**
   * The roster import: its origin pinning is its own, and it reserves the
   * court site's slot before each request.
   */
  "judges/import-cz-us-roster.ts": "reserve",
  /** Test-only helpers, not a path any crawl takes. */
  "ingestion/adapters/test-utils.ts": "test-only",
  "ingestion/adapters/update-fixtures.ts": "test-only",
} as const;

/**
 * Modules outside the scanned trees that still download from a publisher, and
 * do it with a fetch their caller injects.
 *
 * The Slovak document walk is the one of these: it lives in `lib/`, which may
 * not import this slice, so it cannot call the gate itself and the scan above
 * never reaches it. What keeps it honest is the other half of the same rule —
 * it holds no fetch of its own, so the gated fetch its callers pass is the
 * only way it reaches the court's host.
 *
 * Paths are relative to `apps/api/src`.
 */
const INJECTED_FETCH_MODULES = ["lib/legal-search/sk-document-backfill.ts"];

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

/** Every module of a scanned tree, by its path under the handler root. */
const modulesUnder = (tree: string): readonly string[] =>
  readdirSync(nodePath.resolve(caseLawRoot, tree), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) =>
      nodePath
        .relative(caseLawRoot, nodePath.resolve(entry.parentPath, entry.name))
        .replaceAll(nodePath.sep, "/"),
    );

const scannedModules = SCANNED_TREES.flatMap(modulesUnder).toSorted();

const gatedModules = scannedModules.filter(
  (entry) => !(entry in DIRECT_FETCH_MODULES),
);

const sourceOf = async (entry: string): Promise<string> =>
  await Bun.file(nodePath.resolve(caseLawRoot, entry)).text();

const codeOf = async (entry: string): Promise<string> =>
  withoutComments(await sourceOf(entry));

const apiSrcRoot = nodePath.resolve(caseLawRoot, "../..");

const expectNoUngatedCall = (entry: string, code: string): void => {
  for (const { name, pattern } of UNGATED_CALL_PATTERNS) {
    expect(`${entry} uses ${name}: ${pattern.test(code)}`).toBe(
      `${entry} uses ${name}: false`,
    );
  }
};

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

  test("the scan reaches past the adapters", () => {
    // The trees, not one directory: a backfill beside the crawl and the
    // roster import are the modules the adapter-only scan never reached.
    expect(scannedModules).toContain("ingestion/cz-us-judges-backfill.ts");
    expect(scannedModules).toContain("judges/import-cz-us-roster.ts");
    expect(scannedModules).toContain("ingestion/adapters/cz-us.ts");
  });

  test("the list of modules allowed to fetch directly is not stale", async () => {
    for (const entry of Object.keys(DIRECT_FETCH_MODULES)) {
      expect(scannedModules).toContain(entry);
    }

    for (const [entry, role] of Object.entries(DIRECT_FETCH_MODULES)) {
      if (role !== "reserve") {
        continue;
      }
      // A gate wrapper earns its exemption by reserving; one that stopped
      // would otherwise keep the exemption and spend nothing.
      expect(await sourceOf(entry)).toMatch(
        /createPublisherSlot|reservePublisherSlot|createPublisherRequestSlot|createPublisherGateSlot/u,
      );
    }
  });

  test.each(gatedModules)(
    "%s reaches no publisher on its own",
    async (entry) => {
      expectNoUngatedCall(entry, await codeOf(entry));
    },
  );

  test.each(INJECTED_FETCH_MODULES)(
    "%s holds no fetch of its own, so its caller's gated one is the only one",
    async (entry) => {
      const source = await Bun.file(nodePath.resolve(apiSrcRoot, entry)).text();

      expectNoUngatedCall(entry, withoutComments(source));
    },
  );
});
