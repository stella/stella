import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import { createCompilerInputRecorder } from "../apps/api/scripts/lib/compiler-input-stamp";
import {
  generatedStoreDir,
  publishGeneratedOutput,
  restoreGeneratedOutput,
} from "../apps/api/scripts/lib/generated-output-store";
import { createTestState } from "../apps/api/src/tests/helpers/test-state";
import {
  auditPayload,
  buildPayload,
  pullApiTypes,
  resolveBaseCommit,
  restorePayload,
} from "./web-api-types-oci";

const testState = createTestState({ file: import.meta.path, config: {} });
const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  ),
);
const directory = async () => {
  const value = await mkdtemp(path.join(tmpdir(), "api-types-oci-"));
  temporary.push(value);
  return value;
};
const run = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(args, { cwd });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};
const output = "export type API = {};\n";
const fixture = async (root: string, stamp: unknown, text = output) => {
  await writeFile(path.join(root, "stamp.json"), JSON.stringify(stamp));
  await writeFile(path.join(root, "output"), text);
};
const stamp = (extra: Record<string, unknown> = {}) => ({
  outputHash: sha256Hex(output),
  inputs: {
    context: sha256Hex("context"),
    contents: {
      "<root:5>/node_modules/example/index.d.ts": sha256Hex("dependency"),
    },
    installed: {},
    files: { present: [], absent: [] },
    directories: { present: [], absent: [] },
    realpaths: {},
    subdirectories: {},
    listings: [],
    ...extra,
  },
});

type RegistryMode =
  | "valid"
  | "manifest-digest"
  | "blob-digest"
  | "duplicate-title"
  | "unapproved-title";
const registryFixture = (mode: RegistryMode) => {
  const serialized = JSON.stringify(stamp());
  const blobs = new Map([
    [`sha256:${sha256Hex(serialized)}`, serialized],
    [`sha256:${sha256Hex(output)}`, output],
  ]);
  const titles = (() => {
    switch (mode) {
      case "duplicate-title":
        return ["output", "output"];
      case "unapproved-title":
        return ["stamp.json", "../escape"];
      case "valid":
      case "manifest-digest":
      case "blob-digest":
        return ["stamp.json", "output"];
    }
  })();
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: `sha256:${sha256Hex("{}")}`,
      size: 2,
    },
    layers: Array.from(blobs.entries()).map(([digest, content], index) => ({
      mediaType: "application/octet-stream",
      digest,
      size: Buffer.byteLength(content),
      annotations: { "org.opencontainers.image.title": titles.at(index) },
    })),
  });
  const requests: { pathname: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const pathname = new URL(request.url).pathname;
      requests.push({
        pathname,
        authorization: request.headers.get("authorization"),
      });
      if (pathname === "/v2/api-types/manifests/base-commit") {
        return new Response(manifest, {
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "docker-content-digest": `sha256:${sha256Hex(mode === "manifest-digest" ? "tampered" : manifest)}`,
          },
        });
      }
      const content = blobs.get(pathname.replace("/v2/api-types/blobs/", ""));
      if (content === undefined) {
        return new Response("missing", { status: 404 });
      }
      return new Response(
        mode === "blob-digest" ? `${content}tampered` : content,
      );
    },
  });
  testState.setEnv(
    "STELLA_API_TYPES_REGISTRY",
    `http://127.0.0.1:${server.port}/v2/api-types`,
  );
  return { server, requests, serialized };
};

describe("web API types OCI payload", () => {
  test("audits the complete allow-listed portable store entry", async () => {
    const root = await directory();
    await fixture(root, stamp());
    expect(await auditPayload(root, ["SECRET_SENTINEL"])).toEqual([
      "output",
      "stamp.json",
    ]);
  });

  test("rejects mutations outside the portable entry contract", async () => {
    const root = await directory();
    const mutations = [
      { ...stamp(), unexpected: "field" },
      stamp({ files: { present: [], absent: [], unexpected: true } }),
      stamp({ contents: { "/arbitrary/host/file.ts": sha256Hex("source") } }),
      stamp({
        contents: { "C:\\Users\\runner\\file.ts": sha256Hex("source") },
      }),
      stamp({ realpaths: { "<root:5>/source": "/private/host/source" } }),
      stamp({ files: { present: ["/opt/secret"], absent: [] } }),
      stamp({
        installed: { "<root:5>/node_modules/example/index.d.ts": "12:123.45" },
      }),
      stamp({
        contents: { "<root:5>/node_modules/example/index.d.ts": "12:123.45" },
      }),
      stamp({
        contents: { "<root:5>/../../home/runner/secret": sha256Hex("source") },
      }),
      stamp({
        contents: { "<root:5>/apps/../../secret": sha256Hex("source") },
      }),
      { ...stamp(), outputHash: sha256Hex("different output") },
    ];
    for (const mutated of mutations) {
      await fixture(root, mutated);
      expect(String(await rejectionOf(auditPayload(root)))).toContain(
        "OCI payload",
      );
    }
    await fixture(root, stamp());
    await writeFile(path.join(root, "unexpected"), "extra");
    expect(String(await rejectionOf(auditPayload(root)))).toContain(
      "OCI payload",
    );
  });

  test("rejects environment values in otherwise valid generated output", async () => {
    const root = await directory();
    const text = `${output}// SECRET_SENTINEL\n`;
    await fixture(root, { ...stamp(), outputHash: sha256Hex(text) }, text);
    expect(
      String(await rejectionOf(auditPayload(root, ["SECRET_SENTINEL"]))),
    ).toContain("OCI payload");
  });

  test("restores only the audited entry into the configured generated store", async () => {
    const payload = await directory();
    testState.setEnv("STELLA_GENERATED_STORE", await directory());
    const entry = stamp();
    await fixture(payload, entry);
    await restorePayload(payload);
    const restored = path.join(
      generatedStoreDir("web-api-types"),
      sha256Hex(JSON.stringify(entry)),
    );
    expect(await readFile(path.join(restored, "stamp.json"), "utf-8")).toBe(
      JSON.stringify(entry),
    );
    expect(await readFile(path.join(restored, "output"), "utf-8")).toBe(output);
  });

  test("portable store entries survive different dependency mtimes and reject changed source", async () => {
    const sourceRoot = await directory();
    const destinationRoot = await directory();
    const payload = await directory();
    const sourceStore = await directory();
    const destinationStore = await directory();
    const sourceRelative = "apps/api/src/contract.ts";
    const dependencyRelative = "node_modules/example/index.d.ts";
    const generatedRelative = "apps/web/src/generated/api-routes.gen.ts";
    const sourceText = "export type Contract = { status: string };\n";
    const dependencyText = "export interface Dependency { id: string }\n";
    for (const root of [sourceRoot, destinationRoot]) {
      for (const [relative, text] of [
        [sourceRelative, sourceText],
        [dependencyRelative, dependencyText],
        [generatedRelative, output],
      ] as const) {
        const file = path.join(root, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text);
      }
    }
    const sourceDependency = path.join(sourceRoot, dependencyRelative);
    const destinationDependency = path.join(
      destinationRoot,
      dependencyRelative,
    );
    await utimes(sourceDependency, 1000, 1000);
    await utimes(destinationDependency, 2000, 2000);
    expect((await stat(sourceDependency)).mtimeMs).not.toBe(
      (await stat(destinationDependency)).mtimeMs,
    );
    const context = sha256Hex("fixture compiler context");
    const recorder = createCompilerInputRecorder();
    expect(recorder.readFile(path.join(sourceRoot, sourceRelative))).toBe(
      sourceText,
    );
    expect(recorder.readFile(sourceDependency)).toBe(dependencyText);
    const host = recorder.wrap({
      getDirectories: ts.sys.getDirectories,
      readDirectory: ts.sys.readDirectory,
    });
    host.getDirectories(sourceRoot);
    host.readDirectory(
      sourceRoot,
      [".ts"],
      ["node_modules"],
      ["apps/api/src/**/*"],
    );
    const portable = recorder.portableStamp(context, sourceRoot);
    expect(portable.installed).toEqual({});
    testState.setEnv("STELLA_GENERATED_STORE", sourceStore);
    publishGeneratedOutput({
      storeDir: generatedStoreDir("web-api-types"),
      stamp: portable,
      output,
    });
    expect(
      await buildPayload({ root: sourceRoot, destination: payload }),
    ).toEqual(["output", "stamp.json"]);
    testState.setEnv("STELLA_GENERATED_STORE", destinationStore);
    await restorePayload(payload);
    const restored = await restoreGeneratedOutput({
      storeDir: generatedStoreDir("web-api-types"),
      root: destinationRoot,
      context,
    });
    expect(restored?.output.toString("utf-8")).toBe(output);
    expect(restored?.stamp.installed).toEqual({});
    await writeFile(
      path.join(destinationRoot, sourceRelative),
      `${sourceText}export type Changed = true;\n`,
    );
    expect(
      await restoreGeneratedOutput({
        storeDir: generatedStoreDir("web-api-types"),
        root: destinationRoot,
        context,
      }),
    ).toBeUndefined();
  });

  test("an anonymous registry pull verifies both layers and restores the store", async () => {
    const destination = await directory();
    testState.setEnv("STELLA_GENERATED_STORE", await directory());
    const { server, requests, serialized } = registryFixture("valid");
    try {
      await pullApiTypes({ sha: "base-commit", destination });
      const restored = path.join(
        generatedStoreDir("web-api-types"),
        sha256Hex(serialized),
      );
      expect(await readFile(path.join(restored, "stamp.json"), "utf-8")).toBe(
        serialized,
      );
      expect(await readFile(path.join(restored, "output"), "utf-8")).toBe(
        output,
      );
      expect(requests.map(({ pathname }) => pathname).toSorted()).toEqual(
        [
          `/v2/api-types/blobs/sha256:${sha256Hex(output)}`,
          `/v2/api-types/blobs/sha256:${sha256Hex(serialized)}`,
          "/v2/api-types/manifests/base-commit",
        ].toSorted(),
      );
      expect(
        requests.every(({ authorization }) => authorization === null),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test.each([
    ["manifest-digest", "manifest verification failed for base-commit"],
    ["blob-digest", "blob verification failed for base-commit"],
    ["duplicate-title", "manifest file inventory differs for base-commit"],
    ["unapproved-title", "Invalid type"],
  ] as const)(
    "rejects %s before restoring any store entry",
    async (mode, message) => {
      const destination = await directory();
      const store = await directory();
      testState.setEnv("STELLA_GENERATED_STORE", store);
      const { server, requests } = registryFixture(mode);
      try {
        expect(
          String(
            await rejectionOf(
              pullApiTypes({ sha: "base-commit", destination }),
            ),
          ),
        ).toContain(message);
        expect(await readdir(store)).toEqual([]);
        if (mode !== "blob-digest") {
          expect(requests.map(({ pathname }) => pathname)).toEqual([
            "/v2/api-types/manifests/base-commit",
          ]);
        }
      } finally {
        server.stop(true);
      }
    },
  );

  test("resolves a branch base and main HEAD", async () => {
    const root = await directory();
    run(root, "git", "init", "-b", "main");
    run(root, "git", "config", "user.email", "test@example.invalid");
    run(root, "git", "config", "user.name", "Test");
    await writeFile(path.join(root, "file"), "base");
    run(root, "git", "add", "file");
    run(root, "git", "commit", "-m", "base");
    const base = run(root, "git", "rev-parse", "HEAD");
    expect(resolveBaseCommit(root)).toBe(base);
    run(root, "git", "remote", "add", "origin", root);
    run(root, "git", "update-ref", "refs/remotes/origin/main", base);
    run(root, "git", "checkout", "-b", "feature");
    await writeFile(path.join(root, "file"), "feature");
    run(root, "git", "commit", "-am", "feature");
    expect(resolveBaseCommit(root)).toBe(base);
  });

  test("fails closed and names a missing commit", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("missing", { status: 404 }),
    });
    testState.setEnv(
      "STELLA_API_TYPES_REGISTRY",
      `http://127.0.0.1:${server.port}`,
    );
    try {
      expect(
        String(
          await rejectionOf(
            pullApiTypes({ sha: "deadbeef", destination: await directory() }),
          ),
        ),
      ).toContain("unavailable for deadbeef (404)");
    } finally {
      server.stop(true);
    }
  });
});
