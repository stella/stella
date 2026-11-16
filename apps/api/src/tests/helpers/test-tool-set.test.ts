import { expect, test } from "bun:test";

import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

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
