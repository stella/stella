/**
 * Shared test utilities for case-law adapter tests.
 *
 * Provides fixture loading and fetch mocking so adapter
 * tests run against saved responses instead of hitting
 * live APIs. This makes tests fast, deterministic, and
 * resilient to source-site downtime.
 *
 * ## Recording fixtures
 *
 * Run the smoke test for an adapter to record fresh
 * fixture files from the live API:
 *
 * ```bash
 * bun test --test-name-pattern smoke adapters/xx.smoke.test.ts
 * ```
 *
 * ## Using fixtures in unit tests
 *
 * ```ts
 * const restore = mockFetchWithFixtures({
 *   "api.example.com/search": "xx-search.json",
 *   "api.example.com/detail": "xx-detail.html",
 * });
 * afterEach(restore);
 * ```
 */

import { mock } from "bun:test";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

/** Load a fixture file as a string. */
export const loadFixture = async (filename: string): Promise<string> => {
  const path = new URL(filename, FIXTURES_DIR);
  return await Bun.file(path).text();
};

/** Load a fixture file as parsed JSON. */
export const loadJsonFixture = async <T = unknown>(
  filename: string,
): Promise<T> => {
  const text = await loadFixture(filename);
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return JSON.parse(text) as T;
};

/** Save response data as a fixture file. */
export const saveFixture = async (
  filename: string,
  content: string,
): Promise<void> => {
  const path = new URL(filename, FIXTURES_DIR);
  await Bun.write(path, content);
};

type FixtureRoute = {
  /** URL substring to match against. */
  pattern: string;
  /** Fixture filename in __fixtures__/. */
  fixture: string;
  /** Content-Type header (default: inferred from ext). */
  contentType?: string | undefined;
  /** HTTP status (default: 200). */
  status?: number | undefined;
};

const inferContentType = (filename: string): string => {
  if (filename.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filename.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filename.endsWith(".xml")) {
    return "application/xml; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
};

/**
 * Mock globalThis.fetch to serve fixture files based
 * on URL pattern matching.
 *
 * Returns a restore function that resets fetch to the
 * original implementation. Call it in `afterEach`.
 *
 * Unmatched URLs return 404.
 *
 * @example
 * ```ts
 * const restore = await mockFetchWithFixtures([
 *   { pattern: "/search", fixture: "sk-search.json" },
 *   { pattern: "/detail", fixture: "sk-detail.json" },
 * ]);
 * // ... run adapter ...
 * restore();
 * ```
 */
export const mockFetchWithFixtures = async (
  routes: FixtureRoute[],
): Promise<() => void> => {
  const originalFetch = globalThis.fetch;

  // Pre-load all fixtures
  const loaded = await Promise.all(
    routes.map(async (route) => ({
      ...route,
      body: await loadFixture(route.fixture),
    })),
  );

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- mock signature matches fetch for test purposes
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    // Longest-match: prefer more specific patterns
    const match = loaded
      .filter((r) => url.includes(r.pattern))
      .toSorted((a, b) => b.pattern.length - a.pattern.length)
      .at(0);

    if (match) {
      return await Promise.resolve(
        new Response(match.body, {
          status: match.status ?? 200,
          headers: {
            "Content-Type":
              match.contentType ?? inferContentType(match.fixture),
          },
        }),
      );
    }

    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
};

/**
 * Record a live API response as a fixture file.
 * Use this in smoke tests to refresh fixtures.
 */
export const recordFixture = async (
  url: string,
  filename: string,
  headers?: Record<string, string>,
): Promise<string> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    ...(headers && { headers }),
  });

  if (!response.ok) {
    throw new Error(`Failed to record fixture: ${response.status} ${url}`);
  }

  const text = await response.text();
  await saveFixture(filename, text);
  return text;
};
