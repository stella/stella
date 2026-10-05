import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  setSystemTime,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { ADAPTER_MODULES } from "./adapter-registry-lazy";

let time = Date.now();
const cacheDirectories: string[] = [];
beforeEach(() => {
  time += 48 * 60 * 60 * 1000;
  setSystemTime(new Date(time));
});
const createCacheDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-availability-"));
  cacheDirectories.push(directory);
  return directory;
};
const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;
afterEach(() => {
  setSystemTime();
  for (const directory of cacheDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
  globalThis.fetch = originalFetch;
  Bun.sleep = originalSleep;
});

const FAULTS = {
  refused: {
    fetch: async () => new Response("Unavailable", { status: 403 }),
    expected: INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
  },
  connection: {
    fetch: async (): Promise<Response> => {
      throw Object.assign(new TypeError("Connection failed"), {
        code: "ECONNREFUSED",
      });
    },
    expected: INGESTION_STOP_KIND.SOURCE_UNREACHABLE,
  },
  timeout: {
    fetch: async (): Promise<Response> => {
      throw new DOMException("Request timed out", "TimeoutError");
    },
    expected: INGESTION_STOP_KIND.SOURCE_UNREACHABLE,
  },
} as const;

describe("registered adapters classify source availability", () => {
  for (const [key, load] of Object.entries(ADAPTER_MODULES)) {
    for (const [fault, { fetch, expected }] of Object.entries(FAULTS)) {
      test(`${key}: ${fault}`, async () => {
        Bun.sleep = async () => undefined;
        let requests = 0;
        globalThis.fetch = asFetchMock(async () => {
          requests++;
          return await fetch();
        });
        const adapter = await load();
        const page = await adapter.fetchPage(null, {
          cacheDirectory: createCacheDirectory(),
        });
        expect(requests).toBeGreaterThan(0);
        expect(page.isErr()).toBe(true);
        if (page.isErr()) {
          expect(page.error.stopKind).toBe(expected);
        }
      });
    }
  }

  test("a successful landing without the required session is an adapter error", async () => {
    // A successful response with an unexpected session shape is a contract
    // failure; availability cannot be inferred from a missing cookie.
    globalThis.fetch = asFetchMock(async () => new Response("<html></html>"));
    const adapter = await ADAPTER_MODULES["pl-tk"]();
    const page = await adapter.fetchPage(null, {
      cacheDirectory: createCacheDirectory(),
    });
    expect(page.isErr()).toBe(true);
    if (page.isErr()) {
      expect(page.error.stopKind).toBe(INGESTION_STOP_KIND.ADAPTER_ERROR);
    }
  });
});
