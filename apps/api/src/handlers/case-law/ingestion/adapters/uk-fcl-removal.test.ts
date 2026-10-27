import { afterEach, expect, test } from "bun:test";

import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { probeUkFclRemoval } from "./uk-fcl-removal";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const status of [200, 204, 401, 403, 404, 410, 451] as const) {
  test(`document recheck classifies HTTP ${status}`, async () => {
    const urls: string[] = [];
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return new Response(status === 204 ? null : "synthetic response", {
        status,
      });
    });
    const outcome = await probeUkFclRemoval(
      "ewhc/kb/2026/1",
      new AbortController().signal,
    );
    expect(urls).toEqual([
      "https://caselaw.nationalarchives.gov.uk/ewhc/kb/2026/1/data.xml",
    ]);
    if (status === 404 || status === 410) {
      expect(outcome).toEqual({ type: "absent", evidence: `http-${status}` });
      return;
    }
    if (status === 401 || status === 403 || status === 451) {
      expect(outcome).toMatchObject({
        type: "refused",
        status,
        scope: "document",
      });
      return;
    }
    expect(outcome.type).toBe(status === 200 ? "present" : "unavailable");
  });
}

test("an invalid publisher identity performs no request", async () => {
  let calls = 0;
  globalThis.fetch = asFetchMock(async () => {
    calls++;
    return new Response("fixture");
  });
  expect(
    (await probeUkFclRemoval("../document", new AbortController().signal)).type,
  ).toBe("unavailable");
  expect(calls).toBe(0);
});
