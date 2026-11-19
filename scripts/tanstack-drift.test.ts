import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const REGISTRY = "https://registry.npmjs.org";
const SCRIPT = "scripts/tanstack-drift.ts";
const SUITES = "apps/api/src/tests/helpers/recorded-conversation-suites.ts";

test("drift CLI bounds registry reads and preserves ordered catalog and patch outcomes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tanstack-drift-test-"));
  try {
    for (const file of [SCRIPT, SUITES]) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(ROOT, file), target);
    }
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(root, "node_modules"),
    );
    mkdirSync(path.join(root, "patches"));
    const patch =
      "diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+new\n";
    const tarballs = new Map<string, string>();
    for (const [name, contents] of new Map([
      ["ai", "old"],
      ["ai-client", "new"],
      ["ai-openai", "other"],
    ])) {
      const directory = path.join(root, name);
      mkdirSync(path.join(directory, "package"), { recursive: true });
      writeFileSync(path.join(directory, "package/index.js"), `${contents}\n`);
      const archive = path.join(root, `${name}.tgz`);
      const tar = Bun.spawnSync([
        "tar",
        "-czf",
        archive,
        "-C",
        directory,
        "package",
      ]);
      expect(tar.exitCode).toBe(0);
      tarballs.set(`https://registry.npmjs.org/tarballs/${name}.tgz`, archive);
      writeFileSync(path.join(root, `patches/${name}.patch`), patch);
    }
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "drift-fixture",
        private: true,
        catalog: { unrelated: "1.0.0", "@tanstack/ai": "1.0.0" },
        patchedDependencies: {
          "unrelated@1.0.0": "patches/unrelated.patch",
          "@tanstack/ai@1.0.0": "patches/ai.patch",
          "@tanstack/ai-client@1.0.0": "patches/ai-client.patch",
          "@tanstack/ai-openai@1.0.0": "patches/ai-openai.patch",
        },
      }),
    );
    const metadata = (name: string, version: string) => ({
      version,
      dist: { tarball: `${REGISTRY}/tarballs/${name}.tgz` },
      dependencies: {
        "@tanstack/ai-client": "^2.0.0",
        "@tanstack/ai-openai": "^2.0.0",
        ignored: 7,
      },
    });
    const responses = {
      [`${REGISTRY}/@tanstack/ai/latest`]: metadata("ai", "2.0.0"),
      [`${REGISTRY}/@tanstack/ai/2.0.0`]: metadata("ai", "2.0.0"),
      [`${REGISTRY}/@tanstack/ai-client`]: {
        versions: { "1.0.0": {}, "2.0.1": {}, "3.0.0": {} },
      },
      [`${REGISTRY}/@tanstack/ai-client/2.0.1`]: metadata("ai-client", "2.0.1"),
      [`${REGISTRY}/@tanstack/ai-openai`]: { versions: { "2.0.2": {} } },
      [`${REGISTRY}/@tanstack/ai-openai/2.0.2`]: metadata("ai-openai", "2.0.2"),
    };
    writeFileSync(path.join(root, "responses.json"), JSON.stringify(responses));
    writeFileSync(
      path.join(root, "tarballs.json"),
      JSON.stringify(Object.fromEntries(tarballs)),
    );
    writeFileSync(
      path.join(root, "transport.js"),
      `
      const responses = await Bun.file("responses.json").json();
      const tarballs = await Bun.file("tarballs.json").json();
      const requests = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!(init?.signal instanceof AbortSignal) || init.timeout?.type !== "headers" || init.timeout.ms !== 30000) {
          throw new DOMException("Fixture request lacks header deadline", "InvalidStateError");
        }
        requests.push(url);
        await Bun.write("requests.json", JSON.stringify(requests));
        if (Object.hasOwn(responses, url)) return Response.json(responses[url]);
        if (Object.hasOwn(tarballs, url)) return new Response(await Bun.file(tarballs[url]).arrayBuffer());
        throw new DOMException("Unexpected fixture URL: " + url, "NetworkError");
      };
    `,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        "./transport.js",
        SCRIPT,
        "--write-package",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      packages: [{ name: "@tanstack/ai", pinned: "1.0.0", latest: "2.0.0" }],
      patches: [
        { name: "@tanstack/ai", latest: "2.0.0", verdict: "applies" },
        { name: "@tanstack/ai-client", latest: "2.0.1", verdict: "upstream" },
        { name: "@tanstack/ai-openai", latest: "2.0.2", verdict: "conflicts" },
      ],
    });
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf-8"),
    );
    expect(Object.entries(manifest.catalog)).toEqual([
      ["unrelated", "1.0.0"],
      ["@tanstack/ai", "2.0.0"],
    ]);
    expect(Object.entries(manifest.patchedDependencies)).toEqual([
      ["unrelated@1.0.0", "patches/unrelated.patch"],
      ["@tanstack/ai@2.0.0", "patches/ai.patch"],
    ]);
    expect(
      JSON.parse(readFileSync(path.join(root, "requests.json"), "utf-8")),
    ).toEqual([
      `${REGISTRY}/@tanstack/ai/latest`,
      `${REGISTRY}/@tanstack/ai/2.0.0`,
      `${REGISTRY}/tarballs/ai.tgz`,
      `${REGISTRY}/@tanstack/ai-client`,
      `${REGISTRY}/@tanstack/ai-client/2.0.1`,
      `${REGISTRY}/tarballs/ai-client.tgz`,
      `${REGISTRY}/@tanstack/ai-openai`,
      `${REGISTRY}/@tanstack/ai-openai/2.0.2`,
      `${REGISTRY}/tarballs/ai-openai.tgz`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
