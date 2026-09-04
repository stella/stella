import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createStartRuntime,
  StartRuntimeError,
  verifyServerModuleGraph,
} from "./runtime";

const workDirectories: string[] = [];

const createDirectoryUrl = async (): Promise<URL> => {
  const directory = await mkdtemp(path.join(tmpdir(), "start-runtime-"));
  workDirectories.push(directory);
  return pathToFileURL(`${directory}${path.sep}`);
};

afterEach(async () => {
  await Promise.all(
    workDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("Start application runtime", () => {
  test("serves health, immutable assets, and delegated routes through one header boundary", async () => {
    const clientDirectoryUrl = await createDirectoryUrl();
    await mkdir(new URL("assets/", clientDirectoryUrl), { recursive: true });
    await Bun.write(new URL("assets/app.js", clientDirectoryUrl), "export {};");
    const runtime = createStartRuntime({
      clientDirectoryUrl,
      handler: {
        fetch: () =>
          new Response("rendered", {
            headers: { "content-type": "text/html" },
          }),
      },
      responseHeaders: { "x-content-type-options": "nosniff" },
    });

    const health = await runtime.fetch(
      new Request("https://example.test/health"),
    );
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    expect(health.headers.get("cache-control")).toBe("no-store");

    const asset = await runtime.fetch(
      new Request("https://example.test/assets/app.js"),
    );
    expect(await asset.text()).toBe("export {};");
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const rendered = await runtime.fetch(
      new Request("https://example.test/catalogue"),
    );
    expect(await rendered.text()).toBe("rendered");
    for (const response of [health, asset, rendered]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("never resolves encoded traversal outside the client directory", async () => {
    const clientDirectoryUrl = await createDirectoryUrl();
    await Bun.write(new URL("safe.txt", clientDirectoryUrl), "safe");
    const requestedPaths: string[] = [];
    const runtime = createStartRuntime({
      clientDirectoryUrl,
      handler: {
        fetch: (request: Request) => {
          requestedPaths.push(new URL(request.url).pathname);
          return new Response("delegated", { status: 404 });
        },
      },
    });

    const response = await runtime.fetch(
      new Request("https://example.test/%2e%2e%2fsafe.txt"),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("delegated");
    expect(requestedPaths).toEqual(["/%2e%2e%2fsafe.txt"]);
  });

  test("rejects a server bundle without a fetch handler", async () => {
    const clientDirectoryUrl = await createDirectoryUrl();

    expect(() =>
      createStartRuntime({ clientDirectoryUrl, handler: {} }),
    ).toThrow(StartRuntimeError);
  });
});

describe("server module graph verification", () => {
  test("loads every emitted JavaScript module", async () => {
    const serverDirectoryUrl = await createDirectoryUrl();
    await mkdir(new URL("routes/", serverDirectoryUrl), { recursive: true });
    await Bun.write(
      new URL("server.js", serverDirectoryUrl),
      "export default 1;",
    );
    await Bun.write(
      new URL("routes/catalogue.js", serverDirectoryUrl),
      "export const route = 'catalogue';",
    );

    expect(verifyServerModuleGraph({ serverDirectoryUrl })).resolves.toEqual({
      loadedModuleCount: 2,
      toleratedFailures: [],
    });
  });

  test("reports a missing dependency before traffic is accepted", async () => {
    const serverDirectoryUrl = await createDirectoryUrl();
    await Bun.write(
      new URL("server.js", serverDirectoryUrl),
      "import './missing.js'; export default 1;",
    );

    try {
      await verifyServerModuleGraph({ serverDirectoryUrl });
      throw new TypeError("Expected module verification to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(StartRuntimeError);
      expect(error).toMatchObject({ code: "server-module-resolution" });
    }
  });
});
