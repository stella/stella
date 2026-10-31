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

test("fetch mocks support bound preconnect without sending a request", async () => {
  let requests = 0;
  const mockedFetch = asFetchMock(async () => {
    requests += 1;
    return new Response("fixture");
  });
  const preconnect = mockedFetch.preconnect.bind(mockedFetch);
  preconnect("https://example.test");
  expect(requests).toBe(0);
  const response = await mockedFetch("https://example.test");
  expect(await response.text()).toBe("fixture");
  expect(requests).toBe(1);
});
