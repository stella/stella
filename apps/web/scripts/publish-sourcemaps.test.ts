import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  assertChunksInjected,
  isTransientSourcemapProcessFailure,
  listSourcemaps,
  planSourcemapPublish,
  publishSourcemapsWithRetry,
  removeSourcemaps,
  sourcemapProcessCommand,
} from "./publish-sourcemaps";

const transientFailure = (
  stderr = "peer closed connection without sending TLS close_notify",
) => ({ exitCode: 1, stderr });

const successfulProcess = { exitCode: 0, stderr: "" };

const PUBLISH_ENV = {
  POSTHOG_SOURCEMAP_PUBLISH: "true",
  POSTHOG_CLI_API_KEY: "phx_test",
  POSTHOG_CLI_HOST: "https://eu.posthog.com",
  POSTHOG_CLI_PROJECT_ID: "42",
  STELLA_VERSION: "1.2.3",
};

const createDist = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-sourcemaps-"));
  await mkdir(path.join(root, "client/assets"), { recursive: true });
  await mkdir(path.join(root, "server"), { recursive: true });
  await writeFile(
    path.join(root, "client/assets/app-AbCd1234.js"),
    'console.log("app");\n//# chunkId=0195c0f0-app\n',
  );
  await writeFile(path.join(root, "client/assets/app-AbCd1234.js.map"), "{}");
  await writeFile(path.join(root, "server/server.js"), "export {};\n");
  await writeFile(path.join(root, "server/server.js.map"), "{}");
  return root;
};

describe("planSourcemapPublish", () => {
  test("skips unless the build opts in, even when a key is present", () => {
    expect(planSourcemapPublish({})).toEqual({ type: "skip" });
    expect(
      planSourcemapPublish({ ...PUBLISH_ENV, POSTHOG_SOURCEMAP_PUBLISH: "" }),
    ).toEqual({ type: "skip" });
    expect(
      planSourcemapPublish({
        ...PUBLISH_ENV,
        POSTHOG_SOURCEMAP_PUBLISH: "false",
      }),
    ).toEqual({ type: "skip" });
  });

  test("publishes with the key, host, project and version", () => {
    expect(planSourcemapPublish(PUBLISH_ENV)).toEqual({
      type: "publish",
      apiKey: "phx_test",
      host: "https://eu.posthog.com",
      projectId: "42",
      version: "1.2.3",
    });
  });

  test("an opted-in build without its key or destination fails, never skips", () => {
    expect(() =>
      planSourcemapPublish({ ...PUBLISH_ENV, POSTHOG_CLI_API_KEY: " " }),
    ).toThrow(/POSTHOG_CLI_API_KEY/u);
    expect(() =>
      planSourcemapPublish({ ...PUBLISH_ENV, POSTHOG_CLI_PROJECT_ID: "" }),
    ).toThrow(/POSTHOG_CLI_PROJECT_ID/u);
  });

  test("refuses a host that would carry the key in clear text", () => {
    expect(() =>
      planSourcemapPublish({
        ...PUBLISH_ENV,
        POSTHOG_CLI_HOST: "http://eu.posthog.com",
      }),
    ).toThrow(/https/u);
    expect(() =>
      planSourcemapPublish({ ...PUBLISH_ENV, POSTHOG_CLI_HOST: "posthog" }),
    ).toThrow(/https/u);
  });
});

describe("sourcemapProcessCommand", () => {
  test("runs inject and upload against the client chunks under the release", () => {
    const plan = planSourcemapPublish(PUBLISH_ENV);
    if (plan.type !== "publish") {
      throw new Error("expected a publish plan");
    }
    expect(sourcemapProcessCommand(plan, "/app/dist/client")).toEqual({
      cmd: [
        "bun",
        "x",
        "@posthog/cli@0.18.0",
        "sourcemap",
        "process",
        "--directory",
        "/app/dist/client",
        "--release-name",
        "stella-web",
        "--release-version",
        "1.2.3",
      ],
      env: {
        POSTHOG_CLI_API_KEY: "phx_test",
        POSTHOG_CLI_HOST: "https://eu.posthog.com",
        POSTHOG_CLI_PROJECT_ID: "42",
      },
    });
  });
});

describe("source map upload retries", () => {
  test("retries a transient failure and then succeeds", async () => {
    const results = [transientFailure(), successfulProcess];
    const delays: number[] = [];
    const logs: string[] = [];

    await publishSourcemapsWithRetry({
      run: () => results.shift() ?? successfulProcess,
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0.5,
      log: (message) => {
        logs.push(message);
      },
    });

    expect(results).toHaveLength(0);
    expect(delays).toEqual([1000]);
    expect(logs).toHaveLength(2);
  });

  test("exhausts transient retries and reports the last error", async () => {
    const failures = [
      transientFailure("connection reset"),
      transientFailure("HTTP status 503"),
      transientFailure("gateway timeout on final attempt"),
    ];
    let attempts = 0;

    const failure = await rejectionOf(
      publishSourcemapsWithRetry({
        run: () => failures[attempts++] ?? successfulProcess,
        sleep: async () => {},
        random: () => 0.5,
        log: () => {},
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(
      /gateway timeout on final attempt/u,
    );
    expect(attempts).toBe(3);
  });

  test("fails a non-transient error after exactly one attempt", async () => {
    let attempts = 0;

    const failure = await rejectionOf(
      publishSourcemapsWithRetry({
        run: () => {
          attempts += 1;
          return { exitCode: 1, stderr: "HTTP status 401: invalid API key" };
        },
        sleep: async () => {},
        random: () => 0.5,
        log: () => {},
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(
      /invalid API key/u,
    );
    expect(attempts).toBe(1);
  });

  test("applies bounded jitter to exponential backoff", async () => {
    const runWithRandom = async (random: () => number) => {
      let attempts = 0;
      const delays: number[] = [];
      await publishSourcemapsWithRetry({
        run: () =>
          attempts++ < 2
            ? transientFailure("connection closed")
            : successfulProcess,
        sleep: async (delay) => {
          delays.push(delay);
        },
        random,
        log: () => {},
      });
      return delays;
    };

    expect(await runWithRandom(() => 0)).toEqual([500, 1000]);
    expect(await runWithRandom(() => 1)).toEqual([1500, 3000]);
  });

  test("classifies only known transport and server failures as transient", () => {
    expect(isTransientSourcemapProcessFailure(transientFailure())).toBeTrue();
    expect(
      isTransientSourcemapProcessFailure(transientFailure("HTTP status 502")),
    ).toBeTrue();
    expect(
      isTransientSourcemapProcessFailure({
        exitCode: 1,
        stderr: "HTTP status 403: forbidden",
      }),
    ).toBeFalse();
  });
});

describe("source map removal", () => {
  test("removes every map under dist, client and server alike", async () => {
    const root = await createDist();
    expect(await listSourcemaps(root)).toHaveLength(2);
    expect(await removeSourcemaps(root)).toBe(2);
    expect(await listSourcemaps(root)).toEqual([]);
  });
});

describe("source-map injection coverage", () => {
  test("rejects a client build with no mapped JavaScript chunks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-sourcemaps-empty-"));
    const clientRoot = path.join(root, "client");
    await mkdir(path.join(clientRoot, "assets"), { recursive: true });

    let failure: unknown;
    try {
      await assertChunksInjected(clientRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(
      /no mapped client chunks/u,
    );
  });

  test("validates mapped chunks without rejecting emitted mapless assets", async () => {
    const root = await createDist();
    const clientRoot = path.join(root, "client");
    expect(await assertChunksInjected(clientRoot)).toBe(1);

    await writeFile(
      path.join(clientRoot, "assets/render-worker-XyZw5678.js"),
      'console.log("worker");\n',
    );
    expect(await assertChunksInjected(clientRoot)).toBe(1);

    await writeFile(
      path.join(clientRoot, "assets/vendor-QrSt9012.js"),
      'console.log("vendor");\n',
    );
    await writeFile(
      path.join(clientRoot, "assets/vendor-QrSt9012.js.map"),
      "{}",
    );
    let failure: unknown;
    try {
      await assertChunksInjected(clientRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(
      /vendor-QrSt9012\.js/u,
    );
  });
});
