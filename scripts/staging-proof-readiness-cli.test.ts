import { expect, spyOn, test } from "bun:test";

import { readStagingReadiness } from "./staging-proof-readiness-cli";

const COMMIT = "a".repeat(40);

const options = (url: URL) => ({
  url,
  headers: new Headers(),
  expectedCommit: COMMIT,
  timeoutMs: 1000,
});

test("a healthy response from the expected commit is ready", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ status: "ok", commit: COMMIT }),
  });
  try {
    expect(await readStagingReadiness(options(server.url))).toEqual({
      status: "ready",
    });
  } finally {
    await server.stop(true);
  }
});

for (const fixture of [
  {
    name: "a non-200 response",
    status: 503,
    body: JSON.stringify({ status: "ok", commit: COMMIT }),
  },
  {
    name: "a non-200 success response",
    status: 201,
    body: JSON.stringify({ status: "ok", commit: COMMIT }),
  },
  { name: "malformed JSON", status: 200, body: "not JSON" },
  {
    name: "an unexpected commit",
    status: 200,
    body: JSON.stringify({ status: "ok", commit: "b".repeat(40) }),
  },
  {
    name: "an unhealthy status",
    status: 200,
    body: JSON.stringify({ status: "unavailable", commit: COMMIT }),
  },
  {
    name: "a missing commit",
    status: 200,
    body: JSON.stringify({ status: "ok" }),
  },
  { name: "a null payload", status: 200, body: "null" },
  { name: "an array payload", status: 200, body: "[]" },
]) {
  test(`${fixture.name} is not ready`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(fixture.body, { status: fixture.status }),
    });
    try {
      expect(await readStagingReadiness(options(server.url))).toEqual({
        status: "not-ready",
      });
    } finally {
      await server.stop(true);
    }
  });
}

test("a response that does not finish before its timeout is not ready", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream()),
  });
  try {
    expect(
      await readStagingReadiness({ ...options(server.url), timeoutMs: 10 }),
    ).toEqual({ status: "not-ready" });
  } finally {
    await server.stop(true);
  }
});

test("edge access headers reach the server without appearing in output", async () => {
  const edgeHeader = "x-fixture-edge-access";
  const edgeValue = "fixture-header-value";
  const received: (string | null)[] = [];
  const logged = spyOn(console, "log").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      received.push(request.headers.get(edgeHeader));
      return new Response(edgeValue, { status: 503 });
    },
  });
  try {
    const outcome = await readStagingReadiness({
      ...options(server.url),
      headers: new Headers({ [edgeHeader]: edgeValue }),
    });
    expect(received).toEqual([edgeValue]);
    expect(outcome).toEqual({ status: "not-ready" });
    expect(logged).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await server.stop(true);
    logged.mockRestore();
    errors.mockRestore();
  }
});
