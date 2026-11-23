import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { rejectionOf } from "@stll/property-testing/rejection";
import { createStartRuntime } from "@stll/start-runtime";

import {
  createSsrAdmission,
  createSsrShedReporter,
  DEFAULT_SSR_MAX_IN_FLIGHT,
  readSsrAdmissionLimits,
  SSR_MAX_IN_FLIGHT_ENV,
  SSR_SHED_RETRY_AFTER_SECONDS,
  ssrAdmissionLimitsFor,
  withSsrAdmission,
} from "./ssr-admission";

const anonymousRequest = (init?: RequestInit) =>
  new Request("https://stella.test/law/cze/statutes/fixture", init);
const signedInRequest = (init?: RequestInit) =>
  new Request("https://stella.test/workspaces", {
    ...init,
    headers: { cookie: "session=fixture" },
  });

type HeldRender = {
  release: (response?: Response) => void;
  fail: (error: unknown) => void;
};

// A handler whose renders stay in flight until the test settles them.
const createHeldHandler = () => {
  const held: HeldRender[] = [];
  let calls = 0;
  return {
    held,
    calls: () => calls,
    handler: {
      fetch: async () => {
        calls += 1;
        const render = Promise.withResolvers<Response>();
        held.push({
          release: (response = new Response("rendered")) =>
            render.resolve(response),
          fail: (error) => render.reject(error),
        });
        return await render.promise;
      },
    },
  };
};

// Lets the admission and the body pipe settle; no timer is involved.
const flush = async () => {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve();
  }
};

describe("SSR admission limits", () => {
  test("default to a bound sized for the web task", () => {
    const limits = readSsrAdmissionLimits({});
    expect(limits.isOk()).toBe(true);
    expect(limits.unwrap()).toEqual(
      ssrAdmissionLimitsFor(DEFAULT_SSR_MAX_IN_FLIGHT),
    );
    expect(
      readSsrAdmissionLimits({ [SSR_MAX_IN_FLIGHT_ENV]: "" }).unwrap(),
    ).toEqual(ssrAdmissionLimitsFor(DEFAULT_SSR_MAX_IN_FLIGHT));
  });

  test("read a configured bound and keep room for signed-in viewers", () => {
    const limits = readSsrAdmissionLimits({
      [SSR_MAX_IN_FLIGHT_ENV]: " 40 ",
    }).unwrap();
    expect(limits).toEqual({ total: 40, anonymous: 30 });
    expect(ssrAdmissionLimitsFor(2)).toEqual({ total: 2, anonymous: 1 });
  });

  test("reject a bound that is not a whole number in range", () => {
    for (const value of ["0", "1", "1025", "-3", "2.5", "many", "1e3"]) {
      const limits = readSsrAdmissionLimits({ [SSR_MAX_IN_FLIGHT_ENV]: value });
      expect(limits.isErr()).toBe(true);
    }
  });
});

describe("SSR admission", () => {
  test("never lets more requests render than the limit, and sheds the rest at once", async () => {
    const admission = createSsrAdmission({ total: 3, anonymous: 3 });
    const { handler, held, calls } = createHeldHandler();
    const gated = withSsrAdmission({ admission, handler });

    const admitted = [1, 2, 3].map(
      async () => await gated.fetch(anonymousRequest()),
    );
    await flush();
    expect(calls()).toBe(3);
    expect(admission.inFlight().total).toBe(3);

    const shed = await gated.fetch(anonymousRequest());
    expect(shed.status).toBe(503);
    expect(shed.headers.get("Retry-After")).toBe(
      String(SSR_SHED_RETRY_AFTER_SECONDS),
    );
    expect(shed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(calls()).toBe(3);

    for (const render of held) {
      render.release();
    }
    for (const response of await Promise.all(admitted)) {
      expect(await response.text()).toBe("rendered");
    }
    await flush();
    expect(admission.inFlight().total).toBe(0);

    const next = gated.fetch(anonymousRequest());
    await flush();
    held.at(-1)?.release();
    expect((await next).status).toBe(200);
  });

  test("anonymous requests cannot take the slots kept for signed-in viewers", async () => {
    const admission = createSsrAdmission({ total: 3, anonymous: 2 });
    const { handler, held } = createHeldHandler();
    const gated = withSsrAdmission({ admission, handler });

    const first = gated.fetch(anonymousRequest());
    const second = gated.fetch(anonymousRequest());
    await flush();
    expect((await gated.fetch(anonymousRequest())).status).toBe(503);

    const signedIn = gated.fetch(signedInRequest());
    await flush();
    expect(admission.inFlight()).toEqual({ total: 3, anonymous: 2 });
    expect((await gated.fetch(signedInRequest())).status).toBe(503);

    for (const render of held) {
      render.release();
    }
    await Promise.all([first, second, signedIn]);
  });

  test("holds a slot until the body has been sent", async () => {
    const admission = createSsrAdmission({ total: 1, anonymous: 1 });
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const gated = withSsrAdmission({
      admission,
      handler: { fetch: () => new Response(body.readable) },
    });

    const response = await gated.fetch(anonymousRequest());
    expect(admission.inFlight().total).toBe(1);
    expect((await gated.fetch(anonymousRequest())).status).toBe(503);

    const writer = body.writable.getWriter();
    const text = response.text();
    await writer.write(new TextEncoder().encode("streamed"));
    await writer.close();
    expect(await text).toBe("streamed");
    await flush();
    expect(admission.inFlight().total).toBe(0);
  });

  test("releases the slot when the render throws or rejects", async () => {
    const admission = createSsrAdmission({ total: 1, anonymous: 1 });
    const failure = new Error("render failed");
    const throwing = withSsrAdmission({
      admission,
      handler: {
        fetch: () => {
          throw failure;
        },
      },
    });
    expect(await rejectionOf(throwing.fetch(anonymousRequest()))).toBe(failure);
    expect(admission.inFlight().total).toBe(0);

    const { handler, held } = createHeldHandler();
    const rejecting = withSsrAdmission({ admission, handler });
    const pending = rejecting.fetch(anonymousRequest());
    await flush();
    expect(admission.inFlight().total).toBe(1);
    held[0]?.fail(failure);
    expect(await rejectionOf(pending)).toBe(failure);
    expect(admission.inFlight().total).toBe(0);
  });

  test("releases the slot when the body fails or is cancelled", async () => {
    const admission = createSsrAdmission({ total: 1, anonymous: 1 });
    const failing = withSsrAdmission({
      admission,
      handler: {
        fetch: () =>
          new Response(
            new ReadableStream({
              pull: (controller) => controller.error(new Error("stream")),
            }),
          ),
      },
    });
    const failed = await failing.fetch(anonymousRequest());
    expect(await rejectionOf(failed.text())).toBeInstanceOf(Error);
    await flush();
    expect(admission.inFlight().total).toBe(0);

    const endless = withSsrAdmission({
      admission,
      handler: {
        fetch: () =>
          new Response(
            new ReadableStream({
              pull: (controller) =>
                controller.enqueue(new TextEncoder().encode(".")),
            }),
          ),
      },
    });
    const response = await endless.fetch(anonymousRequest());
    expect(admission.inFlight().total).toBe(1);
    await response.body?.cancel();
    await flush();
    expect(admission.inFlight().total).toBe(0);
  });

  test("releases the slot when the viewer disconnects", async () => {
    const admission = createSsrAdmission({ total: 1, anonymous: 1 });
    const { handler, held } = createHeldHandler();
    const gated = withSsrAdmission({ admission, handler });
    const viewer = new AbortController();

    const pending = gated.fetch(anonymousRequest({ signal: viewer.signal }));
    await flush();
    expect(admission.inFlight().total).toBe(1);
    viewer.abort();
    expect(admission.inFlight().total).toBe(0);
    held[0]?.release();
    await (await pending).text();
    expect(admission.inFlight().total).toBe(0);
  });

  test("a slot is released once however many ways the request ends", async () => {
    const admission = createSsrAdmission({ total: 2, anonymous: 2 });
    const viewer = new AbortController();
    const gated = withSsrAdmission({
      admission,
      handler: { fetch: () => new Response("rendered") },
    });
    const response = await gated.fetch(
      anonymousRequest({ signal: viewer.signal }),
    );
    await response.text();
    await flush();
    viewer.abort();
    expect(admission.inFlight()).toEqual({ total: 0, anonymous: 0 });
  });
});

describe("SSR admission in the runtime", () => {
  test("health checks and static files bypass a saturated renderer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ssr-admission-"));
    const clientDirectoryUrl = pathToFileURL(`${directory}${path.sep}`);
    await Bun.write(new URL("robots.txt", clientDirectoryUrl), "User-agent: *");
    const admission = createSsrAdmission({ total: 1, anonymous: 1 });
    const { handler, held } = createHeldHandler();
    const runtime = createStartRuntime({
      clientDirectoryUrl,
      handler: withSsrAdmission({ admission, handler }),
    });

    const rendering = runtime.fetch(anonymousRequest());
    await flush();
    expect((await runtime.fetch(anonymousRequest())).status).toBe(503);
    expect((await runtime.fetch(signedInRequest())).status).toBe(503);

    const health = await runtime.fetch(
      new Request("https://stella.test/health"),
    );
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    const file = await runtime.fetch(
      new Request("https://stella.test/robots.txt"),
    );
    expect(await file.text()).toBe("User-agent: *");

    held[0]?.release();
    expect((await rendering).status).toBe(200);
    await rm(directory, { force: true, recursive: true });
  });
});

describe("shed reporting", () => {
  test("writes at most one line per interval, with the count since the last", () => {
    const lines: string[] = [];
    let now = 0;
    const admission = createSsrAdmission({ total: 4, anonymous: 3 });
    const report = createSsrShedReporter({
      intervalMs: 10_000,
      now: () => now,
      writeDiagnostic: (line) => lines.push(line),
    });
    report(admission);
    for (let index = 0; index < 50; index++) {
      now += 100;
      report(admission);
    }
    now += 10_000;
    report(admission);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      message: "ssr.admission_shed",
      shed: 1,
      limit: 4,
      anonymousLimit: 3,
    });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ shed: 51 });
  });
});
