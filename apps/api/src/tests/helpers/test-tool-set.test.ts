import { expect, test } from "bun:test";

import { asFetchMock } from "./test-tool-set";

test("fetch mocks retain transport setup when captured by another mock", async () => {
  const requests: string[] = [];
  const first = asFetchMock(async (input: string) => {
    requests.push(input);
    return new Response("mock", { status: 201 });
  });
  expect(typeof first.preconnect).toBe("function");
  const capturedPreconnect = first.preconnect.bind(first);
  const second = asFetchMock(first);
  capturedPreconnect("https://example.invalid/");
  second.preconnect("https://example.invalid/");
  expect(requests).toEqual([]);

  const response = await second("https://example.invalid/fixture");
  expect(response.status).toBe(201);
  expect(await response.text()).toBe("mock");
  expect(requests).toEqual(["https://example.invalid/fixture"]);
});
