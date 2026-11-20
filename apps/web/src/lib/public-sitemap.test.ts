import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  createSitemapReadFailureResponse,
  SitemapUpstreamBusyError,
} from "./public-sitemap";

describe("sitemap read failure responses", () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);

  afterEach(() => {
    stdout.mockClear();
  });

  afterAll(() => {
    stdout.mockRestore();
  });

  const loggedLines = (): unknown[] =>
    stdout.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

  test("a busy refusal answers 503 with Retry-After and logs one line", () => {
    const response = createSitemapReadFailureResponse(
      new SitemapUpstreamBusyError({
        action: "readShard",
        message: "busy",
        retryAfter: "7",
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(loggedLines()).toEqual([{ message: "web.sitemap.busy_refusal" }]);
  });

  test("any other read failure answers 503 and logs no refusal", () => {
    const response = createSitemapReadFailureResponse(new Error("unreadable"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(loggedLines()).toEqual([]);
  });
});
