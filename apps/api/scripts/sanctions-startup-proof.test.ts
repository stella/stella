import { expect, test } from "bun:test";

import { proveSanctionsStartup } from "./sanctions-startup-proof";

const requestUrl = (request: string | URL | Request): string => {
  if (request instanceof URL) {
    return request.href;
  }
  if (typeof request === "string") {
    return request;
  }
  return request.url;
};

test("polls started before searching and rejects a warming list", async () => {
  const requests: string[] = [];
  const responses = [
    new Response(null, { status: 503 }),
    Response.json({ status: "started" }),
    Response.json({ lists: [{ source: "eu", reason: "warming" }] }),
  ];

  const failure = await proveSanctionsStartup({
    baseUrl: "https://api.example.test",
    fetch: async (request) => {
      requests.push(requestUrl(request));
      return responses.shift() ?? new Response(null, { status: 500 });
    },
    sleep: async () => undefined,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    message: "Sanctions search reported warming after /started",
  });
  expect(requests).toEqual([
    "https://api.example.test/started",
    "https://api.example.test/started",
    "https://api.example.test/sanctions/search",
  ]);
});

test("passes when every list is warm or terminally failed", async () => {
  const responses = [
    Response.json({ status: "started" }),
    Response.json({
      lists: [
        { source: "eu", reason: null },
        { source: "un", reason: "load-failed" },
      ],
    }),
  ];
  await proveSanctionsStartup({
    baseUrl: "https://api.example.test",
    fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
  });
});
