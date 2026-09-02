import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertChunksInjected,
  listSourcemaps,
  planSourcemapPublish,
  removeSourcemaps,
  sourcemapProcessCommand,
} from "./publish-sourcemaps";

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

describe("source map removal", () => {
  test("removes every map under dist, client and server alike", async () => {
    const root = await createDist();
    expect(await listSourcemaps(root)).toHaveLength(2);
    expect(await removeSourcemaps(root)).toBe(2);
    expect(await listSourcemaps(root)).toEqual([]);
  });
});

describe("source-map injection coverage", () => {
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
