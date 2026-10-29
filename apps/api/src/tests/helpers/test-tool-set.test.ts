import { describe, expect, test } from "bun:test";

import { asFetchMock } from "./test-tool-set";

describe("asFetchMock", () => {
  test("keeps Bun's preconnect method available on mocked fetch", () => {
    const fetchMock = asFetchMock(async () => new Response());

    expect(typeof fetchMock.preconnect).toBe("function");
  });
});
