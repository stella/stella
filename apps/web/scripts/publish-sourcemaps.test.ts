import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertChunksInjected,
  listSourcemaps,
  planSourcemapPublish,
  removeSourcemaps,
} from "./publish-sourcemaps";

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
  test("skips without a key, including a whitespace-only one", () => {
    expect(planSourcemapPublish({})).toEqual({
      type: "skip",
      reason: "no_api_key",
    });
    expect(planSourcemapPublish({ POSTHOG_CLI_API_KEY: "  " })).toEqual({
      type: "skip",
      reason: "no_api_key",
    });
  });

  test("publishes with the host, project and version the key implies", () => {
    expect(
      planSourcemapPublish({
        POSTHOG_CLI_API_KEY: "phx_test",
        POSTHOG_CLI_HOST: "https://eu.posthog.com",
        POSTHOG_CLI_PROJECT_ID: "42",
        STELLA_VERSION: "1.2.3",
      }),
    ).toEqual({
      type: "publish",
      host: "https://eu.posthog.com",
      projectId: "42",
      version: "1.2.3",
    });
  });

  test("refuses a key without a destination rather than defaulting one", () => {
    expect(() =>
      planSourcemapPublish({
        POSTHOG_CLI_API_KEY: "phx_test",
        POSTHOG_CLI_HOST: "https://eu.posthog.com",
        STELLA_VERSION: "1.2.3",
      }),
    ).toThrow(/POSTHOG_CLI_PROJECT_ID/u);
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

describe("assertChunksInjected", () => {
  test("counts injected chunks and names the ones the CLI skipped", async () => {
    const root = await createDist();
    const clientRoot = path.join(root, "client");
    expect(await assertChunksInjected(clientRoot)).toBe(1);

    await writeFile(
      path.join(clientRoot, "assets/vendor-XyZw5678.js"),
      'console.log("vendor");\n',
    );
    await expect(assertChunksInjected(clientRoot)).rejects.toThrow(
      /vendor-XyZw5678\.js/u,
    );
  });
});
